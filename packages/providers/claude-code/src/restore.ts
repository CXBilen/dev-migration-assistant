/**
 * restore: applies an approved plan through ctx.fs (ScopedFs rooted at the approved destinations).
 * Merge semantics (ADR-0008): sessions add-only by id (identical -> skip, differing -> <id>.devmig-conflict.jsonl),
 * memory/file-history/session-env add-only, history.jsonl append-missing, ~/.claude.json add-only with a backup copy.
 */
import path from 'node:path'
import type {
  ProviderRestoreInput,
  ProviderRestorePlan,
  ProviderRestoreResult,
  RestoreContext,
} from '@devmig/core'
import type { AttentionItem, CollisionPolicy, ResultItem } from '@devmig/model'
import { MigrationError, hashFile, throwIfAborted, walkFiles, type ScopedFs } from '@devmig/shared'
import {
  applyMcpEnv,
  assertNoIdentityKeys,
  findProjectEntryKey,
  isJsonObject,
  mergeAddOnly,
  readClaudeJson,
} from './claude-json'
import { CLAUDE_CODE_PROVIDER_ID } from './constants'
import {
  copyFileAtomic,
  fileTimestamp,
  formatJson,
  isExistingDirectory,
  isExistingFile,
  readOptionalJson,
  writeChunk,
  writeStreamAtomic,
} from './fs-helpers'
import { historyRowKey, readHistoryKeys, readHistoryRows } from './history'
import { payloadFile } from './plan'
import {
  ProjectClaudeJsonPayloadSchema,
  RestoreStateSchema,
  UserClaudeJsonPayloadSchema,
  UserMcpEnvPayloadSchema,
  type JsonObject,
  type RestoreResultState,
  type RestoreState,
} from './schema'
import { readJsonlLines, rewriteTranscript, type MapPath } from './transcript'

export interface RestoreDeps {
  now: () => Date
}

interface Bookkeeping {
  items: ResultItem[]
  warnings: string[]
  failures: number
  result: RestoreResultState
}

function policyFor(
  plan: ProviderRestorePlan,
  decisions: Record<string, CollisionPolicy>,
  collisionId: string | undefined,
): CollisionPolicy | undefined {
  if (!collisionId) return undefined
  return (
    decisions[collisionId] ?? plan.collisions.find((c) => c.id === collisionId)?.policy ?? 'skip'
  )
}

/** Copies every file under src into dest, skipping files that already exist (add-only). Optionally rewrites JSONL transcripts. */
async function copyTreeAddOnly(
  scoped: ScopedFs,
  src: string,
  dest: string,
  options: {
    signal?: AbortSignal
    rewrite?: { mapPath: MapPath; oldPaths: readonly string[] } | undefined
  },
): Promise<{ copied: number; skipped: number; rewrittenFields: number }> {
  const stats = { copied: 0, skipped: 0, rewrittenFields: 0 }
  for await (const entry of walkFiles(src, {
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    throwIfAborted(options.signal)
    if (!entry.dirent.isFile()) continue
    const target = path.join(dest, ...entry.relativePath.split('/'))
    if (await isExistingFile(target)) {
      stats.skipped += 1
      continue
    }
    if (options.rewrite && entry.relativePath.endsWith('.jsonl')) {
      const r = await rewriteTranscript(
        entry.absolutePath,
        target,
        options.rewrite.mapPath,
        scoped,
        {
          oldPaths: options.rewrite.oldPaths,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      )
      stats.rewrittenFields += r.rewrittenFields
    } else {
      await copyFileAtomic(scoped, entry.absolutePath, target, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
    }
    stats.copied += 1
  }
  return stats
}

async function backupThenReplacePath(scoped: ScopedFs, dest: string, now: Date): Promise<string> {
  const backup = `${dest}.devmig-backup-${fileTimestamp(now)}`
  await scoped.rename(dest, backup)
  return backup
}

async function restoreSessions(
  state: RestoreState,
  plan: ProviderRestorePlan,
  ctx: RestoreContext,
  book: Bookkeeping,
): Promise<void> {
  for (const s of state.sessions) {
    throwIfAborted(ctx.signal)
    const policy = policyFor(plan, ctx.collisionDecisions, s.collisionId)
    if (policy === 'skip') {
      book.result.sessionsSkipped.push(s.dirName)
      book.items.push({
        label: `Sessions ${s.dirName}`,
        status: 'info',
        detail: `skipped: ${s.destDir} already has sessions`,
      })
      continue
    }
    const srcDir = payloadFile(ctx.payloadRoot, s.payloadPath)
    const rewrite = s.rewrite ? { mapPath: ctx.mapPath, oldPaths: state.oldPaths } : undefined
    let written = 0
    let identical = 0
    let conflicts = 0
    let missing = 0
    let rewrittenFields = 0
    ctx.progress(`Restoring ${s.sessionIds.length} sessions into ${s.destDirName}…`)
    await ctx.fs.mkdir(s.destDir)
    for (const sid of s.sessionIds) {
      throwIfAborted(ctx.signal)
      const src = path.join(srcDir, `${sid}.jsonl`)
      if (!(await isExistingFile(src))) {
        missing += 1
        continue
      }
      const dest = path.join(s.destDir, `${sid}.jsonl`)
      const exists = await isExistingFile(dest)
      const target = exists ? path.join(s.destDir, `${sid}.devmig-incoming.jsonl`) : dest
      if (rewrite) {
        const r = await rewriteTranscript(src, target, rewrite.mapPath, ctx.fs, {
          oldPaths: rewrite.oldPaths,
          signal: ctx.signal,
          label: `${sid}.jsonl`,
        })
        rewrittenFields += r.rewrittenFields
      } else {
        await copyFileAtomic(ctx.fs, src, target, { signal: ctx.signal })
      }
      if (exists) {
        const [a, b] = await Promise.all([hashFile(dest, ctx.signal), hashFile(target, ctx.signal)])
        if (a.sha256 === b.sha256) {
          await ctx.fs.rm(target)
          identical += 1
        } else {
          const conflict = path.join(s.destDir, `${sid}.devmig-conflict.jsonl`)
          await ctx.fs.rename(target, conflict)
          conflicts += 1
          book.result.conflictFiles.push(conflict)
          book.warnings.push(
            `Session ${sid} already exists with different content; the backup copy was written to ${conflict}`,
          )
        }
      } else {
        written += 1
      }
      const sessionDir = path.join(srcDir, sid)
      if (await isExistingDirectory(sessionDir)) {
        const r = await copyTreeAddOnly(ctx.fs, sessionDir, path.join(s.destDir, sid), {
          signal: ctx.signal,
          rewrite,
        })
        rewrittenFields += r.rewrittenFields
      }
    }
    if (missing > 0)
      book.warnings.push(
        `${missing} transcript(s) listed for ${s.dirName} were missing from the backup`,
      )
    book.result.sessionsWritten[s.dirName] = written
    const details = [`${written} added`]
    if (identical > 0) details.push(`${identical} identical skipped`)
    if (conflicts > 0) details.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`)
    if (rewrite)
      details.push(`${rewrittenFields} path field${rewrittenFields === 1 ? '' : 's'} remapped`)
    if (s.unverifiable) details.push('directory name unverifiable (>200 chars)')
    book.items.push({
      label: `Sessions → ${s.destDirName}`,
      status: conflicts > 0 || s.unverifiable ? 'warn' : 'ok',
      detail: details.join(', '),
    })
  }
}

async function restoreMemory(
  state: RestoreState,
  plan: ProviderRestorePlan,
  ctx: RestoreContext,
  book: Bookkeeping,
): Promise<void> {
  for (const m of state.memory) {
    throwIfAborted(ctx.signal)
    const policy = policyFor(plan, ctx.collisionDecisions, m.collisionId)
    if (policy === 'skip') {
      book.result.memorySkipped.push(m.dirName)
      book.items.push({
        label: 'Project memory',
        status: 'info',
        detail: `skipped: ${m.destDir} already exists`,
      })
      continue
    }
    const r = await copyTreeAddOnly(
      ctx.fs,
      payloadFile(ctx.payloadRoot, m.payloadPath),
      m.destDir,
      { signal: ctx.signal, rewrite: undefined },
    )
    book.items.push({
      label: 'Project memory',
      status: 'ok',
      detail:
        r.skipped > 0 ? `${r.copied} files added, ${r.skipped} existing kept` : `${r.copied} files`,
    })
  }
}

async function restoreSessionKeyed(
  entry: RestoreState['fileHistory'],
  label: string,
  ctx: RestoreContext,
  book: Bookkeeping,
): Promise<void> {
  if (!entry) return
  const srcRoot = payloadFile(ctx.payloadRoot, entry.payloadPath)
  let copied = 0
  let skipped = 0
  for (const sid of entry.sessionIds) {
    throwIfAborted(ctx.signal)
    const src = path.join(srcRoot, sid)
    if (!(await isExistingDirectory(src))) continue
    const r = await copyTreeAddOnly(ctx.fs, src, path.join(entry.destRoot, sid), {
      signal: ctx.signal,
      rewrite: undefined,
    })
    copied += r.copied
    skipped += r.skipped
  }
  book.items.push({
    label,
    status: 'ok',
    detail: skipped > 0 ? `${copied} files added, ${skipped} existing kept` : `${copied} files`,
  })
}

async function restoreHistory(
  state: RestoreState,
  ctx: RestoreContext,
  book: Bookkeeping,
): Promise<void> {
  const h = state.history
  if (!h) return
  const src = payloadFile(ctx.payloadRoot, h.payloadPath)
  const existingKeys = await readHistoryKeys(h.destFile, ctx.signal)
  const destExists = await isExistingFile(h.destFile)
  let appended = 0
  let skipped = 0
  await writeStreamAtomic(ctx.fs, h.destFile, async (out) => {
    if (destExists) {
      for await (const line of readJsonlLines(h.destFile, { signal: ctx.signal })) {
        await writeChunk(out, `${line.text}\n`)
      }
    }
    for await (const line of readHistoryRows(src, { signal: ctx.signal })) {
      const key = historyRowKey(line.row)
      if (key && existingKeys.has(key)) {
        skipped += 1
        continue
      }
      if (key) existingKeys.add(key)
      const record: JsonObject = { ...line.record }
      if (typeof record.project === 'string') record.project = ctx.mapPath(record.project).newPath
      await writeChunk(out, `${JSON.stringify(record)}\n`)
      appended += 1
    }
  })
  book.items.push({
    label: 'Prompt history',
    status: 'ok',
    detail: `${appended} entries appended${skipped > 0 ? `, ${skipped} already present` : ''}`,
  })
}

async function backupClaudeJson(
  ctx: RestoreContext,
  claudeConfigDir: string,
  file: string,
  now: Date,
): Promise<string | undefined> {
  if (!(await isExistingFile(file))) return undefined
  const backup = path.join(
    claudeConfigDir,
    'devmig-backups',
    `claude.json.${fileTimestamp(now)}.bak`,
  )
  await ctx.fs.copyFile(file, backup)
  return backup
}

async function loadClaudeJsonForWrite(file: string): Promise<JsonObject> {
  const existing = await readClaudeJson(file)
  return existing ?? {}
}

async function restoreProjectClaudeJson(
  state: RestoreState,
  plan: ProviderRestorePlan,
  ctx: RestoreContext,
  deps: RestoreDeps,
  book: Bookkeeping,
): Promise<void> {
  const cj = state.claudeJson
  if (!cj) return
  const payloadRaw = await readOptionalJson(payloadFile(ctx.payloadRoot, cj.payloadPath))
  const payload = ProjectClaudeJsonPayloadSchema.safeParse(payloadRaw)
  if (!payload.success) {
    throw new MigrationError('MANIFEST_INVALID', 'claude-json.json in the backup is invalid', {
      details: { issues: payload.error.issues.slice(0, 3).map((i) => i.message) },
    })
  }
  const target = await loadClaudeJsonForWrite(cj.destFile)
  const projects = isJsonObject(target.projects) ? target.projects : {}
  target.projects = projects
  let added = 0
  let merged = 0
  let skipped = 0
  const written: string[] = []
  for (const entry of cj.entries) {
    throwIfAborted(ctx.signal)
    const source = payload.data.projects[entry.oldPath]
    if (!isJsonObject(source)) {
      book.warnings.push(`No project entry for ${entry.oldPath} in the backup`)
      continue
    }
    const incoming = structuredClone(source)
    if (
      cj.includeMcpEnv &&
      payload.data.mcpEnv?.[entry.oldPath] &&
      isJsonObject(incoming.mcpServers)
    ) {
      applyMcpEnv(incoming.mcpServers, payload.data.mcpEnv[entry.oldPath] ?? {})
    }
    assertNoIdentityKeys(incoming, `projects["${entry.newPath}"]`)
    const existingKey = findProjectEntryKey(projects, entry.newPath)
    if (existingKey !== undefined) {
      const policy = policyFor(plan, ctx.collisionDecisions, entry.collisionId) ?? 'skip'
      if (policy === 'merge' && isJsonObject(projects[existingKey])) {
        mergeAddOnly(projects[existingKey], incoming)
        merged += 1
        written.push(entry.newPath)
      } else {
        skipped += 1
      }
      continue
    }
    projects[entry.newPath] = incoming
    added += 1
    written.push(entry.newPath)
  }
  assertNoIdentityKeysFromPayload(payload.data.projects)
  if (added + merged > 0) {
    const backup = await backupClaudeJson(ctx, state.claudeConfigDir, cj.destFile, deps.now())
    await ctx.fs.writeFileAtomic(cj.destFile, formatJson(target))
    book.result.claudeJsonEntriesWritten = written
    book.items.push({
      label: '~/.claude.json project entries',
      status: 'ok',
      detail: `${added} added${merged > 0 ? `, ${merged} merged` : ''}${skipped > 0 ? `, ${skipped} skipped (exist)` : ''}${backup ? ` · original backed up to ${backup}` : ''}`,
    })
  } else {
    book.result.claudeJsonSkipped = true
    book.items.push({
      label: '~/.claude.json project entries',
      status: 'info',
      detail: `${skipped} entr${skipped === 1 ? 'y' : 'ies'} already present; nothing written`,
    })
  }
}

function assertNoIdentityKeysFromPayload(projects: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(projects)) {
    if (isJsonObject(value)) assertNoIdentityKeys(value, `projects["${key}"]`)
  }
}

async function restoreProjectFiles(
  state: RestoreState,
  plan: ProviderRestorePlan,
  ctx: RestoreContext,
  deps: RestoreDeps,
  book: Bookkeeping,
): Promise<void> {
  for (const f of state.projectFiles) {
    throwIfAborted(ctx.signal)
    const src = payloadFile(ctx.payloadRoot, f.payloadPath)
    const policy = policyFor(plan, ctx.collisionDecisions, f.collisionId)
    if (policy === 'skip') {
      book.items.push({ label: f.relativePath, status: 'info', detail: 'skipped: already exists' })
      continue
    }
    let note = ''
    if (policy === 'backup-then-replace' && (await isExistingFile(f.dest))) {
      note = ` · existing file moved to ${path.basename(await backupThenReplacePath(ctx.fs, f.dest, deps.now()))}`
    }
    await copyFileAtomic(ctx.fs, src, f.dest, { signal: ctx.signal })
    book.items.push({ label: f.relativePath, status: 'ok', detail: `restored${note}` })
  }
}

async function restoreGlobalFiles(
  state: RestoreState,
  plan: ProviderRestorePlan,
  ctx: RestoreContext,
  deps: RestoreDeps,
  book: Bookkeeping,
): Promise<void> {
  for (const g of state.global) {
    const srcBase = payloadFile(ctx.payloadRoot, g.payloadPath)
    for (const entry of g.entries) {
      throwIfAborted(ctx.signal)
      const src = path.join(srcBase, ...entry.relative.split('/'))
      const policy = policyFor(plan, ctx.collisionDecisions, entry.collisionId)
      if (policy === 'skip') {
        book.items.push({
          label: entry.relative,
          status: 'info',
          detail: 'skipped: already exists',
        })
        continue
      }
      if (entry.isDirectory) {
        if (!(await isExistingDirectory(src))) continue
        let note = ''
        if (policy === 'backup-then-replace' && (await isExistingDirectory(entry.dest))) {
          note = ` · existing directory moved to ${path.basename(await backupThenReplacePath(ctx.fs, entry.dest, deps.now()))}`
        }
        const r = await copyTreeAddOnly(ctx.fs, src, entry.dest, {
          signal: ctx.signal,
          rewrite: undefined,
        })
        book.items.push({
          label: `${entry.relative}/`,
          status: 'ok',
          detail: `${r.copied} files added${r.skipped > 0 ? `, ${r.skipped} existing kept` : ''}${note}`,
        })
        continue
      }
      if (!(await isExistingFile(src))) continue
      if (policy === 'merge') {
        const existingRaw = await readOptionalJson(entry.dest)
        const incomingRaw = await readOptionalJson(src)
        if (!isJsonObject(existingRaw) || !isJsonObject(incomingRaw)) {
          book.warnings.push(
            `${entry.relative} could not be merged (not a JSON object); left unchanged`,
          )
          book.items.push({
            label: entry.relative,
            status: 'warn',
            detail: 'merge not possible; existing file kept',
          })
          continue
        }
        const r = mergeAddOnly(existingRaw, incomingRaw)
        await ctx.fs.writeFileAtomic(entry.dest, formatJson(existingRaw))
        book.items.push({
          label: entry.relative,
          status: 'ok',
          detail: `merged: ${r.added.length} keys added, ${r.kept.length} existing kept`,
        })
        continue
      }
      let note = ''
      if (policy === 'backup-then-replace' && (await isExistingFile(entry.dest))) {
        note = ` · existing file moved to ${path.basename(await backupThenReplacePath(ctx.fs, entry.dest, deps.now()))}`
      }
      await copyFileAtomic(ctx.fs, src, entry.dest, { signal: ctx.signal })
      book.items.push({ label: entry.relative, status: 'ok', detail: `restored${note}` })
    }
  }
}

async function restoreUserClaudeJson(
  state: RestoreState,
  plan: ProviderRestorePlan,
  ctx: RestoreContext,
  deps: RestoreDeps,
  book: Bookkeeping,
): Promise<void> {
  const g = state.globalClaudeJson
  if (!g) return
  const filePolicy = policyFor(plan, ctx.collisionDecisions, g.fileCollisionId)
  if (filePolicy === 'skip') {
    book.result.claudeJsonSkipped = true
    book.items.push({
      label: '~/.claude.json user scope',
      status: 'info',
      detail: 'skipped: file exists',
    })
    return
  }
  const payload = UserClaudeJsonPayloadSchema.safeParse(
    await readOptionalJson(payloadFile(ctx.payloadRoot, g.payloadPath)),
  )
  if (!payload.success) {
    throw new MigrationError('MANIFEST_INVALID', 'claude-json-user.json in the backup is invalid')
  }
  let mcpEnv: Record<string, { env?: Record<string, unknown>; headers?: Record<string, unknown> }> =
    {}
  if (g.includeMcpEnv && g.mcpEnvPayloadPath) {
    const env = UserMcpEnvPayloadSchema.safeParse(
      await readOptionalJson(payloadFile(ctx.payloadRoot, g.mcpEnvPayloadPath)),
    )
    if (env.success) mcpEnv = env.data.mcpServers
  }
  const target = await loadClaudeJsonForWrite(g.destFile)
  const servers = isJsonObject(target.mcpServers) ? target.mcpServers : {}
  let addedServers = 0
  let mergedServers = 0
  let skippedServers = 0
  for (const [name, definition] of Object.entries(payload.data.mcpServers)) {
    const incoming = isJsonObject(definition) ? structuredClone(definition) : definition
    const secret = mcpEnv[name]
    if (isJsonObject(incoming) && secret) applyMcpEnv({ [name]: incoming }, { [name]: secret })
    if (Object.hasOwn(servers, name)) {
      const collision = g.serverCollisions.find((c) => c.name === name)
      const policy = policyFor(plan, ctx.collisionDecisions, collision?.collisionId) ?? 'skip'
      if (policy === 'merge' && isJsonObject(servers[name]) && isJsonObject(incoming)) {
        mergeAddOnly(servers[name], incoming)
        mergedServers += 1
      } else {
        skippedServers += 1
      }
      continue
    }
    servers[name] = incoming
    addedServers += 1
  }
  if (Object.keys(servers).length > 0 || Object.hasOwn(target, 'mcpServers'))
    target.mcpServers = servers
  const config = mergeAddOnly(target, payload.data.config)
  assertNoIdentityKeys(payload.data.config, 'claude-json-user.json config')
  const changed = addedServers + mergedServers + config.added.length > 0
  if (changed) {
    const backup = await backupClaudeJson(ctx, state.claudeConfigDir, g.destFile, deps.now())
    await ctx.fs.writeFileAtomic(g.destFile, formatJson(target))
    book.items.push({
      label: '~/.claude.json user scope',
      status: 'ok',
      detail: `${addedServers} MCP server${addedServers === 1 ? '' : 's'} added${mergedServers > 0 ? `, ${mergedServers} merged` : ''}${skippedServers > 0 ? `, ${skippedServers} skipped` : ''}, ${config.added.length} config key${config.added.length === 1 ? '' : 's'} added${backup ? ` · original backed up to ${backup}` : ''}`,
    })
  } else {
    book.items.push({
      label: '~/.claude.json user scope',
      status: 'info',
      detail: 'nothing to add',
    })
  }
}

async function claudeInstalled(ctx: RestoreContext): Promise<boolean> {
  try {
    const result = await ctx.exec('claude', ['--version'], {
      reject: false,
      timeoutMs: 10_000,
      env: ctx.env,
      signal: ctx.signal,
    })
    return !result.failed
  } catch (err) {
    if ((err as { code?: string }).code === 'CANCELLED') throw err
    return false
  }
}

export async function restore(
  plan: ProviderRestorePlan,
  _input: ProviderRestoreInput,
  ctx: RestoreContext,
  deps: RestoreDeps,
): Promise<ProviderRestoreResult> {
  const parsed = RestoreStateSchema.safeParse(plan.state)
  if (!parsed.success) {
    throw new MigrationError(
      'RESTORE_PLAN_REJECTED',
      'The Claude Code restore plan state is invalid',
      {
        details: {
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        },
      },
    )
  }
  const state = parsed.data
  const book: Bookkeeping = {
    items: [],
    warnings: [],
    failures: 0,
    result: {
      sessionsWritten: {},
      sessionsSkipped: [],
      memorySkipped: [],
      claudeJsonEntriesWritten: [],
      claudeJsonSkipped: false,
      conflictFiles: [],
    },
  }
  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      if (ctx.signal.aborted || (err as { code?: string }).code === 'CANCELLED') throw err
      book.failures += 1
      const message = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`${label} failed`, { error: message })
      book.items.push({ label, status: 'error', detail: message })
      book.warnings.push(`${label} failed: ${message}`)
    }
  }

  await run('Sessions', () => restoreSessions(state, plan, ctx, book))
  await run('Project memory', () => restoreMemory(state, plan, ctx, book))
  await run('File history', () =>
    restoreSessionKeyed(state.fileHistory, 'Checkpoint blobs', ctx, book),
  )
  await run('Prompt history', () => restoreHistory(state, ctx, book))
  await run('~/.claude.json project entries', () =>
    restoreProjectClaudeJson(state, plan, ctx, deps, book),
  )
  await run('Project files', () => restoreProjectFiles(state, plan, ctx, deps, book))
  await run('User-wide files', () => restoreGlobalFiles(state, plan, ctx, deps, book))
  await run('~/.claude.json user scope', () => restoreUserClaudeJson(state, plan, ctx, deps, book))

  const attention: AttentionItem[] = [
    {
      id: 'reauth',
      providerId: CLAUDE_CODE_PROVIDER_ID,
      level: 'info',
      title: 'Claude Code authentication required',
      detail: 'Credentials are never migrated. Run `claude` and sign in on this Mac.',
      action: 'reauth',
    },
  ]
  if (state.mcpEnvServersNotRestored.length > 0) {
    attention.push({
      id: 'mcp-env',
      providerId: CLAUDE_CODE_PROVIDER_ID,
      level: 'warn',
      title: `MCP server env values need to be re-entered: ${[...new Set(state.mcpEnvServersNotRestored)].join(', ')}`,
      detail:
        'Environment values and headers of MCP servers were not restored (excluded by default because they may contain tokens).',
      action: 'manual',
    })
  }
  if (!(await claudeInstalled(ctx))) {
    attention.push({
      id: 'install',
      providerId: CLAUDE_CODE_PROVIDER_ID,
      level: 'warn',
      title: 'Claude Code not installed',
      detail:
        '`claude --version` did not succeed on this Mac. Install Claude Code to use the restored sessions.',
      action: 'install',
    })
  }
  const status =
    book.failures === 0 ? 'ok' : book.failures === book.items.length ? 'failed' : 'partial'
  return {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    ...(plan.projectId ? { projectId: plan.projectId } : {}),
    status,
    items: book.items,
    warnings: book.warnings,
    attention,
    state: book.result as unknown as Record<string, unknown>,
  }
}
