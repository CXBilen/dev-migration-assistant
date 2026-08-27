/**
 * verify: independent checks that the restore produced what the plan promised
 * (session counts, remapped cwd, untouched message content, checkpoint blobs, ~/.claude.json entries, memory files).
 */
import path from 'node:path'
import type { ProviderVerification, ProviderVerifyInput, VerifyContext } from '@devmig/core'
import type { VerificationCheck } from '@devmig/model'
import { throwIfAborted, walkFiles } from '@devmig/shared'
import { findProjectEntryKey, readClaudeJson } from './claude-json'
import { CLAUDE_CODE_PROVIDER_ID } from './constants'
import { isExistingDirectory, isExistingFile } from './fs-helpers'
import { isSamePathOrChild } from './history'
import { payloadFile } from './plan'
import { RestoreResultStateSchema, RestoreStateSchema } from './schema'
import { readJsonlLines } from './transcript'

const SAMPLE_TRANSCRIPTS = 3

async function countFiles(dir: string, signal: AbortSignal | undefined): Promise<number> {
  if (!(await isExistingDirectory(dir))) return 0
  let n = 0
  for await (const entry of walkFiles(dir, { ...(signal ? { signal } : {}) })) {
    if (entry.dirent.isFile()) n += 1
  }
  return n
}

export async function verify(
  input: ProviderVerifyInput,
  ctx: VerifyContext,
): Promise<ProviderVerification> {
  const checks: VerificationCheck[] = []
  const stateParsed = RestoreStateSchema.safeParse(input.plan.state)
  if (!stateParsed.success) {
    return {
      checks: [
        {
          id: 'state',
          label: 'Claude Code restore plan state',
          status: 'fail',
          detail: 'invalid plan state',
          providerId: CLAUDE_CODE_PROVIDER_ID,
        },
      ],
    }
  }
  const state = stateParsed.data
  const result = RestoreResultStateSchema.safeParse(input.result.state ?? {})
  const written = result.success ? result.data : RestoreResultStateSchema.parse({})
  const push = (
    id: string,
    label: string,
    status: VerificationCheck['status'],
    detail?: string,
  ): void => {
    checks.push({
      id,
      label,
      status,
      ...(detail ? { detail } : {}),
      providerId: CLAUDE_CODE_PROVIDER_ID,
      ...(state.project ? { projectId: state.project.id } : {}),
    })
  }

  // ---- sessions: counts + sampled content ----
  let sampled = 0
  for (const s of state.sessions) {
    throwIfAborted(ctx.signal)
    if (written.sessionsSkipped.includes(s.dirName)) {
      push(
        `sessions:${s.dirName}`,
        `Sessions ${s.destDirName}`,
        'warn',
        'skipped by collision policy; not verified',
      )
      continue
    }
    let present = 0
    for (const sid of s.sessionIds) {
      if (await isExistingFile(path.join(s.destDir, `${sid}.jsonl`))) present += 1
    }
    const conflicts = written.conflictFiles.filter((f) =>
      f.startsWith(`${s.destDir}${path.sep}`),
    ).length
    push(
      `sessions:${s.dirName}:count`,
      `Sessions present in ${s.destDirName}`,
      present === s.sessionIds.length ? (conflicts > 0 ? 'warn' : 'pass') : 'fail',
      `${present}/${s.sessionIds.length} transcripts${conflicts > 0 ? `, ${conflicts} kept as conflict files` : ''}`,
    )
    const srcDir = payloadFile(ctx.payloadRoot, s.payloadPath)
    for (const sid of s.sessionIds) {
      if (sampled >= SAMPLE_TRANSCRIPTS) break
      throwIfAborted(ctx.signal)
      const src = path.join(srcDir, `${sid}.jsonl`)
      const dest = path.join(s.destDir, `${sid}.jsonl`)
      if (!(await isExistingFile(src)) || !(await isExistingFile(dest))) continue
      if (written.conflictFiles.some((f) => f.startsWith(path.join(s.destDir, sid)))) continue
      sampled += 1
      const srcIter = readJsonlLines(src, { signal: ctx.signal })[Symbol.asyncIterator]()
      let records = 0
      let staleCwd = 0
      let outsideCwd = 0
      let messageMismatch = 0
      let lineMismatch = false
      for await (const line of readJsonlLines(dest, { signal: ctx.signal })) {
        const srcLine = await srcIter.next()
        if (srcLine.done) {
          lineMismatch = true
          break
        }
        if (!line.record) {
          if (srcLine.value.text !== line.text) lineMismatch = true
          continue
        }
        records += 1
        const cwd = line.record.cwd
        if (typeof cwd === 'string') {
          if (state.project?.pathChanged && isSamePathOrChild(state.project.oldPath, cwd))
            staleCwd += 1
          else if (
            !isSamePathOrChild(s.newCwd, cwd) &&
            !(state.project && isSamePathOrChild(state.project.newPath, cwd))
          )
            outsideCwd += 1
        }
        const srcMessage = srcLine.value.record
          ? JSON.stringify(srcLine.value.record.message ?? null)
          : null
        const destMessage = JSON.stringify(line.record.message ?? null)
        if (srcMessage !== destMessage) messageMismatch += 1
      }
      const trailing = await srcIter.next()
      if (!trailing.done) lineMismatch = true
      await srcIter.return?.(undefined)
      const problems: string[] = []
      if (staleCwd > 0) problems.push(`${staleCwd} record(s) still carry the old path in cwd`)
      if (messageMismatch > 0)
        problems.push(`${messageMismatch} record(s) have altered message content`)
      if (lineMismatch) problems.push('line count differs from the backup')
      push(
        `sessions:${s.dirName}:${sid}`,
        `Transcript ${sid.slice(0, 8)}… remapped safely`,
        problems.length > 0 ? 'fail' : outsideCwd > 0 ? 'warn' : 'pass',
        problems.length > 0
          ? problems.join('; ')
          : `${records} records, cwd → ${s.newCwd}${outsideCwd > 0 ? `; ${outsideCwd} record(s) ran outside the project (e.g. after /cd)` : ''}, message content byte-identical`,
      )
    }
  }

  // ---- file history blobs ----
  if (state.fileHistory) {
    const srcRoot = payloadFile(ctx.payloadRoot, state.fileHistory.payloadPath)
    let expected = 0
    let present = 0
    for (const sid of state.fileHistory.sessionIds) {
      throwIfAborted(ctx.signal)
      expected += await countFiles(path.join(srcRoot, sid), ctx.signal)
      present += await countFiles(path.join(state.fileHistory.destRoot, sid), ctx.signal)
    }
    push(
      'file-history',
      'Checkpoint blobs present',
      present >= expected ? 'pass' : 'fail',
      `${present}/${expected} blobs`,
    )
  }

  // ---- ~/.claude.json entries ----
  if (state.claudeJson) {
    const json = await readClaudeJson(state.claudeJson.destFile).catch(() => undefined)
    for (const entry of state.claudeJson.entries) {
      const exists = json?.projects
        ? findProjectEntryKey(json.projects, entry.newPath) !== undefined
        : false
      const skipped = !written.claudeJsonEntriesWritten.includes(entry.newPath)
      push(
        `claude-json:${entry.newPath}`,
        `~/.claude.json entry for ${entry.newPath}`,
        exists ? 'pass' : skipped ? 'warn' : 'fail',
        exists
          ? skipped
            ? 'present (existing entry kept)'
            : 'present'
          : skipped
            ? 'skipped by collision policy'
            : 'missing',
      )
    }
  }

  // ---- memory ----
  for (const m of state.memory) {
    throwIfAborted(ctx.signal)
    if (written.memorySkipped.includes(m.dirName)) {
      push(`memory:${m.dirName}`, 'Project memory', 'warn', 'skipped by collision policy')
      continue
    }
    const src = payloadFile(ctx.payloadRoot, m.payloadPath)
    let expected = 0
    let missing = 0
    for await (const entry of walkFiles(src, { signal: ctx.signal })) {
      if (!entry.dirent.isFile()) continue
      expected += 1
      if (!(await isExistingFile(path.join(m.destDir, ...entry.relativePath.split('/')))))
        missing += 1
    }
    push(
      `memory:${m.dirName}`,
      'Project memory files present',
      missing === 0 ? 'pass' : 'fail',
      `${expected - missing}/${expected} files`,
    )
  }

  // ---- global entries ----
  for (const g of state.global) {
    for (const entry of g.entries) {
      throwIfAborted(ctx.signal)
      const exists = entry.isDirectory
        ? await isExistingDirectory(entry.dest)
        : await isExistingFile(entry.dest)
      push(`global:${entry.relative}`, `${entry.relative} present`, exists ? 'pass' : 'fail')
    }
  }
  if (state.globalClaudeJson && !written.claudeJsonSkipped) {
    const exists = await isExistingFile(state.globalClaudeJson.destFile)
    push('claude-json-user', '~/.claude.json present', exists ? 'pass' : 'fail')
  }
  if (state.history) {
    push(
      'history',
      'Prompt history file present',
      (await isExistingFile(state.history.destFile)) ? 'pass' : 'fail',
    )
  }
  return { checks }
}
