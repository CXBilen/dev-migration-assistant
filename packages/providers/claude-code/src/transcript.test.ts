import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPathMapper } from '@devmig/core'
import { ScopedFs } from '@devmig/shared'
import {
  buildClaudeTranscript,
  makeTempRoot,
  readJsonl,
  writeJsonlLines,
  type TempRoot,
} from '@devmig/test-utils'
import {
  PATH_BEARING_FIELDS,
  countPathFields,
  readJsonlLines,
  rewriteRecordPaths,
  rewriteTranscript,
  sampleTranscriptMetadata,
  type JsonRecord,
  type RewriteContext,
} from './transcript'

const OLD = '/Users/alice/Documents/GitHub/demo'
const NEW = '/Users/bob/Developer/demo'
const mapper = createPathMapper([{ projectId: 'p', oldPath: OLD, newPath: NEW }], {
  homeDir: '/Users/bob',
})
const mapPath = (p: string) => mapper.mapPath(p)

function ctx(): RewriteContext {
  return { oldPaths: [OLD], unsupportedReferences: [] }
}

let tmp: TempRoot
beforeEach(async () => {
  tmp = await makeTempRoot('devmig-claude-transcript-')
})
afterEach(async () => {
  await tmp.cleanup()
})

describe('readJsonlLines', () => {
  it('streams records, keeps invalid and blank lines, and stops at maxRecords', async () => {
    const file = path.join(tmp.root, 'a.jsonl')
    await fs.writeFile(file, '{"a":1}\n\nnot json\n[1,2]\n{"b":2}\n{"c":3}\n')
    const all = []
    for await (const line of readJsonlLines(file)) all.push(line)
    expect(all.map((l) => l.record)).toEqual([{ a: 1 }, null, null, null, { b: 2 }, { c: 3 }])
    expect(all.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4, 5, 6])
    const limited = []
    for await (const line of readJsonlLines(file, { maxRecords: 2 })) limited.push(line)
    expect(limited.filter((l) => l.record).length).toBe(2)
  })

  it('throws CANCELLED when the signal is aborted', async () => {
    const file = path.join(tmp.root, 'b.jsonl')
    await fs.writeFile(file, '{"a":1}\n{"b":2}\n')
    const controller = new AbortController()
    const iter = readJsonlLines(file, { signal: controller.signal })
    await iter.next()
    controller.abort()
    await expect(iter.next()).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})

describe('sampleTranscriptMetadata', () => {
  it('collects session id, cwds, branches, versions, timestamps and counts', async () => {
    const file = path.join(tmp.root, 's.jsonl')
    const built = buildClaudeTranscript({
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: OLD,
      gitBranch: 'main',
      ordinal: 1,
      transcriptDir: '/Users/alice/.claude/projects/-Users-alice-Documents-GitHub-demo',
    })
    const lines = [
      ...built.lines,
      JSON.stringify({
        type: 'relocated',
        relocatedCwd: `${OLD}/.claude/worktrees/x`,
        sessionId: 'x',
      }),
      JSON.stringify({
        type: 'worktree-state',
        worktreeSession: {
          originalCwd: OLD,
          preEnterOriginalCwd: OLD,
          worktreePath: `${OLD}/.claude/worktrees/x`,
        },
        sessionId: 'x',
      }),
    ]
    await writeJsonlLines(file, lines)
    const meta = await sampleTranscriptMetadata(file)
    expect(meta.sessionId).toBe('11111111-1111-4111-8111-111111111111')
    expect([...meta.cwds]).toEqual([OLD])
    expect([...meta.gitBranches]).toEqual(['main'])
    expect([...meta.versions]).toEqual(['2.1.247'])
    expect(meta.firstTimestamp).toBe('2026-08-20T11:01:00.000Z')
    expect(meta.lastTimestamp).toBe('2026-08-20T11:03:00.000Z')
    expect(meta.recordCount).toBe(built.recordCount + 2)
    expect(meta.invalidLineCount).toBe(1)
    expect(meta.hasWorktreeState).toBe(true)
    expect([...meta.relocatedCwds]).toEqual([`${OLD}/.claude/worktrees/x`])
    expect(meta.truncated).toBe(false)
  })

  it('respects maxRecords and marks the sample as truncated', async () => {
    const file = path.join(tmp.root, 't.jsonl')
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ type: 'user', cwd: `/p/${i}` }),
    )
    await writeJsonlLines(file, lines)
    const meta = await sampleTranscriptMetadata(file, { maxRecords: 3 })
    expect(meta.recordCount).toBe(3)
    expect(meta.cwds.size).toBe(3)
    expect(meta.truncated).toBe(true)
  })
})

describe('rewriteRecordPaths', () => {
  it('lists exactly the documented fields', () => {
    expect(PATH_BEARING_FIELDS).toEqual([
      'cwd',
      'relocatedCwd',
      'trackingPath',
      'worktreeSession.originalCwd',
      'worktreeSession.preEnterOriginalCwd',
      'worktreeSession.worktreePath',
      'backup.realParentDir',
      'snapshot.trackedFileBackups.*.realParentDir',
      'toolUseResult.filePath',
      'toolUseResult.file.filePath',
      'toolUseResult.originalFile',
      'toolUseResult.outputFile',
      'toolUseResult.persistedOutputPath',
      'toolUseResult.scriptPath',
      'toolUseResult.transcriptDir',
      'toolUseResult.worktreePath',
      'toolUseResult.originalCwd',
    ])
  })

  it('rewrites every listed field (exact and child paths, nested wildcard keys) and nothing else', () => {
    const record: JsonRecord = {
      type: 'user',
      cwd: OLD,
      relocatedCwd: `${OLD}/.claude/worktrees/x`,
      trackingPath: 'README.md',
      worktreeSession: {
        originalCwd: OLD,
        preEnterOriginalCwd: `${OLD}/sub`,
        worktreePath: `${OLD}/.claude/worktrees/x`,
      },
      backup: { realParentDir: `${OLD}/src`, backupFileName: 'abc@v1' },
      snapshot: {
        trackedFileBackups: {
          'src/index.ts': { realParentDir: OLD, version: 1 },
          'README.md': { realParentDir: `${OLD}/docs` },
        },
      },
      toolUseResult: {
        filePath: `${OLD}/README.md`,
        file: { filePath: `${OLD}/README.md`, content: `see ${OLD}/README.md` },
        originalFile: `${OLD}/a`,
        outputFile: `${OLD}/b`,
        persistedOutputPath: `${OLD}/c`,
        scriptPath: `${OLD}/d`,
        transcriptDir: '/Users/alice/.claude/projects/x',
        worktreePath: `${OLD}/.claude/worktrees/x`,
        originalCwd: OLD,
        stdout: `${OLD}/free-text`,
      },
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `path ${OLD}/src` },
          { type: 'tool_use', input: { file_path: `${OLD}/x` } },
        ],
      },
    }
    const before = JSON.stringify(record.message)
    const c = ctx()
    const result = rewriteRecordPaths(record, mapPath, c)
    expect(result.rewrittenFields).toBe(16)
    expect(result.changed).toBe(true)
    expect(record.cwd).toBe(NEW)
    expect(record.relocatedCwd).toBe(`${NEW}/.claude/worktrees/x`)
    expect(record.trackingPath).toBe('README.md')
    expect(record.worktreeSession).toEqual({
      originalCwd: NEW,
      preEnterOriginalCwd: `${NEW}/sub`,
      worktreePath: `${NEW}/.claude/worktrees/x`,
    })
    expect(record.backup).toEqual({ realParentDir: `${NEW}/src`, backupFileName: 'abc@v1' })
    expect(record.snapshot).toEqual({
      trackedFileBackups: {
        'src/index.ts': { realParentDir: NEW, version: 1 },
        'README.md': { realParentDir: `${NEW}/docs` },
      },
    })
    const tur = record.toolUseResult as Record<string, unknown>
    expect(tur.filePath).toBe(`${NEW}/README.md`)
    expect((tur.file as Record<string, unknown>).filePath).toBe(`${NEW}/README.md`)
    expect((tur.file as Record<string, unknown>).content).toBe(`see ${OLD}/README.md`)
    expect(tur.originalFile).toBe(`${NEW}/a`)
    expect(tur.outputFile).toBe(`${NEW}/b`)
    expect(tur.persistedOutputPath).toBe(`${NEW}/c`)
    expect(tur.scriptPath).toBe(`${NEW}/d`)
    expect(tur.transcriptDir).toBe('/Users/alice/.claude/projects/x')
    expect(tur.worktreePath).toBe(`${NEW}/.claude/worktrees/x`)
    expect(tur.originalCwd).toBe(NEW)
    expect(tur.stdout).toBe(`${OLD}/free-text`)
    expect(JSON.stringify(record.message)).toBe(before)
    expect(c.unsupportedReferences).toEqual([])
  })

  it('rewrites an absolute trackingPath but leaves relative ones alone', () => {
    const record: JsonRecord = { trackingPath: `${OLD}/memory.md` }
    expect(rewriteRecordPaths(record, mapPath, ctx()).rewrittenFields).toBe(1)
    expect(record.trackingPath).toBe(`${NEW}/memory.md`)
  })

  it('reports unknown top-level string keys that point into an old path without rewriting them', () => {
    const record: JsonRecord = {
      type: 'x',
      mysteryPath: `${OLD}/thing`,
      other: '/elsewhere',
      message: { content: `${OLD}/x` },
    }
    const c = { ...ctx(), location: 's.jsonl:3' }
    const result = rewriteRecordPaths(record, mapPath, c)
    expect(result).toEqual({ rewrittenFields: 0, unsupported: 1, changed: false })
    expect(record.mysteryPath).toBe(`${OLD}/thing`)
    expect(c.unsupportedReferences).toEqual([
      {
        location: 's.jsonl:3 · mysteryPath',
        reason: 'Unknown field "mysteryPath" references an old path; left unchanged',
      },
    ])
  })

  it('leaves unmapped paths and non-string values untouched', () => {
    const record: JsonRecord = {
      cwd: '/Users/carol/other',
      toolUseResult: 'plain string result',
      backup: null,
    }
    const result = rewriteRecordPaths(record, mapPath, ctx())
    expect(result.changed).toBe(false)
    expect(record).toEqual({
      cwd: '/Users/carol/other',
      toolUseResult: 'plain string result',
      backup: null,
    })
  })
})

describe('rewriteTranscript', () => {
  it('streams, preserves invalid lines and key order, keeps prose byte-identical and writes atomically', async () => {
    const src = path.join(tmp.root, 'src', 's.jsonl')
    const dest = path.join(tmp.root, 'dest', 'out', 's.jsonl')
    const built = buildClaudeTranscript({
      sessionId: 'abc',
      cwd: OLD,
      gitBranch: 'main',
      ordinal: 2,
      transcriptDir: '/Users/alice/.claude/projects/-Users-alice-Documents-GitHub-demo',
    })
    const lines = [
      ...built.lines,
      '',
      '   ',
      JSON.stringify({ zeta: 1, alpha: 2, cwd: OLD, mysteryPath: `${OLD}/q` }),
    ]
    await writeJsonlLines(src, lines)
    await fs.mkdir(path.join(tmp.root, 'dest'), { recursive: true })
    const scoped = new ScopedFs([path.join(tmp.root, 'dest')])
    const unsupported: { location: string; reason: string }[] = []
    const result = await rewriteTranscript(src, dest, mapPath, scoped, {
      oldPaths: [OLD],
      unsupportedReferences: unsupported,
    })
    expect(result).toEqual({
      records: built.recordCount + 1,
      rewrittenFields: 3 + 2 + 1 + 1 + 1,
      unsupported: 1,
      invalidLines: 1,
    })
    const out = (await fs.readFile(dest, 'utf8')).split('\n')
    expect(out[out.length - 1]).toBe('')
    expect(out[built.lines.length - 1]).toBe('not json')
    expect(out[built.lines.length]).toBe('')
    expect(out[built.lines.length + 1]).toBe('   ')
    expect(out[built.lines.length + 2]).toBe(
      JSON.stringify({ zeta: 1, alpha: 2, cwd: NEW, mysteryPath: `${OLD}/q` }),
    )
    const srcRecords = (await readJsonl(src)).records
    const destRecords = (await readJsonl(dest)).records
    expect(destRecords.length).toBe(srcRecords.length)
    for (let i = 0; i < srcRecords.length; i += 1) {
      expect(Object.keys(destRecords[i] as object)).toEqual(Object.keys(srcRecords[i] as object))
      expect(JSON.stringify(destRecords[i]?.message ?? null)).toBe(
        JSON.stringify(srcRecords[i]?.message ?? null),
      )
    }
    const assistant = destRecords.find((r) => r.type === 'assistant') as {
      message: { content: { text?: string }[] }
    }
    expect(assistant.message.content[0]?.text).toContain(OLD)
    expect(destRecords.filter((r) => typeof r.cwd === 'string').every((r) => r.cwd === NEW)).toBe(
      true,
    )
    expect(unsupported).toHaveLength(1)
    const leftovers = (await fs.readdir(path.dirname(dest))).filter((n) => n.includes('devmig-tmp'))
    expect(leftovers).toEqual([])
  })

  it('refuses to write outside the ScopedFs roots', async () => {
    const src = path.join(tmp.root, 'src2.jsonl')
    await writeJsonlLines(src, [JSON.stringify({ cwd: OLD })])
    const scoped = new ScopedFs([path.join(tmp.root, 'allowed')])
    await expect(
      rewriteTranscript(src, path.join(tmp.root, 'elsewhere', 'x.jsonl'), mapPath, scoped, {
        oldPaths: [OLD],
      }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' })
  })

  it('countPathFields is a dry run with a record budget', async () => {
    const src = path.join(tmp.root, 'c.jsonl')
    await writeJsonlLines(
      src,
      Array.from({ length: 5 }, () => JSON.stringify({ cwd: OLD, backup: { realParentDir: OLD } })),
    )
    const counted = await countPathFields(src, mapPath, { oldPaths: [OLD], maxRecords: 3 })
    expect(counted).toEqual({ records: 3, pathFields: 6, unsupported: 0, truncated: true })
    expect((await fs.readFile(src, 'utf8')).includes(NEW)).toBe(false)
  })
})
