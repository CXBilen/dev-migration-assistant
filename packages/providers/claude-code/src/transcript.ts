/**
 * Streaming JSONL transcript utilities (docs/research/claude-code-storage.md §4, ADR-0005).
 *
 * - `readJsonlLines` never loads a whole file; invalid lines are yielded with `record: null`.
 * - `sampleTranscriptMetadata` extracts matching evidence (cwd, gitBranch, version, ...).
 * - `rewriteRecordPaths` rewrites ONLY the fields listed in PATH_BEARING_FIELDS; `message.content`
 *   and every other string stay byte-for-byte untouched.
 */
import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import { z } from 'zod'
import { MigrationError, isAbortError, type ScopedFs } from '@devmig/shared'
import { DEFAULT_SAMPLE_RECORDS } from './constants'
import { writeChunk, writeStreamAtomic } from './fs-helpers'

export type JsonRecord = Record<string, unknown>

export interface JsonlLine {
  /** 1-based line number. */
  lineNumber: number
  /** The raw line without its terminator. */
  text: string
  /** Parsed JSON object, or null for blank/invalid/non-object lines. */
  record: JsonRecord | null
}

export interface ReadJsonlOptions {
  signal?: AbortSignal
  /** Stop after this many parsed records (the stream is closed early). */
  maxRecords?: number
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Streams a JSONL file line by line. Blank lines are yielded too (record null) so writers can preserve them. */
export async function* readJsonlLines(
  file: string,
  options: ReadJsonlOptions = {},
): AsyncGenerator<JsonlLine> {
  const stream = createReadStream(file, {
    encoding: 'utf8',
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let lineNumber = 0
  let records = 0
  try {
    for await (const text of rl) {
      lineNumber += 1
      if (options.signal?.aborted) {
        throw new MigrationError('CANCELLED', 'The operation was cancelled.', { recoverable: true })
      }
      let record: JsonRecord | null = null
      if (text.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(text)
          if (isJsonRecord(parsed)) record = parsed
        } catch {
          record = null
        }
      }
      yield { lineNumber, text, record }
      if (record) {
        records += 1
        if (options.maxRecords !== undefined && records >= options.maxRecords) break
      }
    }
  } catch (err) {
    if (err instanceof MigrationError) throw err
    if (isAbortError(err)) {
      throw new MigrationError('CANCELLED', 'The operation was cancelled.', { recoverable: true })
    }
    throw new MigrationError('IO_ERROR', `Cannot read transcript ${file}`, {
      details: { file },
      cause: err,
    })
  } finally {
    rl.close()
    stream.destroy()
  }
}

/** Minimal, tolerant view of a transcript record used for evidence sampling. Unknown keys are ignored. */
export const TranscriptRecordSchema = z.looseObject({
  type: z.string().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  timestamp: z.string().optional(),
  relocatedCwd: z.string().optional(),
  worktreeSession: z
    .looseObject({
      originalCwd: z.string().optional(),
      preEnterOriginalCwd: z.string().optional(),
      worktreePath: z.string().optional(),
    })
    .optional(),
})

export interface TranscriptMetadata {
  file: string
  sessionId: string | null
  cwds: Set<string>
  gitBranches: Set<string>
  versions: Set<string>
  firstTimestamp: string | null
  lastTimestamp: string | null
  /** Valid records seen (bounded by maxRecords). */
  recordCount: number
  invalidLineCount: number
  hasWorktreeState: boolean
  relocatedCwds: Set<string>
  /** True when sampling stopped before the end of the file. */
  truncated: boolean
}

export interface SampleOptions {
  maxRecords?: number
  signal?: AbortSignal
}

/** Reads up to `maxRecords` records (default 200) and collects the fields the resolver needs. */
export async function sampleTranscriptMetadata(
  file: string,
  options: SampleOptions = {},
): Promise<TranscriptMetadata> {
  const maxRecords = options.maxRecords ?? DEFAULT_SAMPLE_RECORDS
  const meta: TranscriptMetadata = {
    file,
    sessionId: null,
    cwds: new Set(),
    gitBranches: new Set(),
    versions: new Set(),
    firstTimestamp: null,
    lastTimestamp: null,
    recordCount: 0,
    invalidLineCount: 0,
    hasWorktreeState: false,
    relocatedCwds: new Set(),
    truncated: false,
  }
  let sawEnd = true
  for await (const line of readJsonlLines(file, {
    maxRecords,
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    if (!line.record) {
      if (line.text.trim() !== '') meta.invalidLineCount += 1
      continue
    }
    meta.recordCount += 1
    const parsed = TranscriptRecordSchema.safeParse(line.record)
    if (!parsed.success) continue
    const r = parsed.data
    if (r.cwd && r.cwd.length > 0) meta.cwds.add(r.cwd)
    if (r.sessionId && meta.sessionId === null) meta.sessionId = r.sessionId
    if (r.gitBranch) meta.gitBranches.add(r.gitBranch)
    if (r.version) meta.versions.add(r.version)
    if (r.timestamp) {
      meta.firstTimestamp ??= r.timestamp
      meta.lastTimestamp = r.timestamp
    }
    if (r.relocatedCwd) meta.relocatedCwds.add(r.relocatedCwd)
    if (r.type === 'worktree-state' || r.worktreeSession) {
      meta.hasWorktreeState = true
      const ws = r.worktreeSession
      if (ws?.worktreePath) meta.relocatedCwds.add(ws.worktreePath)
    }
    if (meta.recordCount >= maxRecords) {
      sawEnd = false
      break
    }
  }
  meta.truncated = !sawEnd
  return meta
}

/**
 * Every structured field known to hold an absolute path (research §4.3). `*` matches any key.
 * `trackingPath` is usually repo-relative and is only rewritten when absolute.
 * `message.content` (prose, tool inputs) is NEVER listed here by design (ADR-0005).
 */
export const PATH_BEARING_FIELDS: readonly string[] = [
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
]

const PATH_BEARING_ROOTS = new Set(PATH_BEARING_FIELDS.map((f) => f.split('.')[0] as string))
const NEVER_INSPECT_KEYS = new Set(['message'])

export type MapPath = (oldPath: string) => { newPath: string; changed: boolean; mapped: boolean }

export interface UnsupportedReferenceRecord {
  location: string
  reason: string
}

export interface RewriteContext {
  /** Old absolute paths of the mappings; used to detect references we do not rewrite. */
  oldPaths: readonly string[]
  /** Collected (bounded) list of unsupported references. */
  unsupportedReferences: UnsupportedReferenceRecord[]
  /** Human location of the record for reports, e.g. "<sid>.jsonl:12". */
  location?: string
  /** Maximum number of unsupported references kept in the list (counts continue). */
  maxUnsupported?: number
}

export interface RewriteRecordResult {
  rewrittenFields: number
  unsupported: number
  changed: boolean
}

function containsOldPath(value: string, oldPaths: readonly string[]): boolean {
  return oldPaths.some((p) => p.length > 0 && value.includes(p))
}

function rewriteAt(
  node: unknown,
  segments: readonly string[],
  index: number,
  mapPath: MapPath,
): number {
  if (!isJsonRecord(node)) return 0
  const segment = segments[index]
  if (segment === undefined) return 0
  const isLeaf = index === segments.length - 1
  const keys = segment === '*' ? Object.keys(node) : [segment]
  let count = 0
  for (const key of keys) {
    if (!Object.hasOwn(node, key)) continue
    const value = node[key]
    if (isLeaf) {
      if (typeof value === 'string' && value.startsWith('/')) {
        const mapped = mapPath(value)
        if (mapped.mapped && mapped.changed) {
          node[key] = mapped.newPath
          count += 1
        }
      }
    } else {
      count += rewriteAt(value, segments, index + 1, mapPath)
    }
  }
  return count
}

/**
 * Rewrites the path-bearing fields of one record in place. Only exact/child paths that the mapper
 * knows are changed; unknown top-level string keys that look like a path into an old location are
 * reported (not rewritten).
 */
export function rewriteRecordPaths(
  record: JsonRecord,
  mapPath: MapPath,
  ctx: RewriteContext,
): RewriteRecordResult {
  let rewrittenFields = 0
  for (const field of PATH_BEARING_FIELDS) {
    rewrittenFields += rewriteAt(record, field.split('.'), 0, mapPath)
  }
  let unsupported = 0
  const limit = ctx.maxUnsupported ?? 50
  for (const [key, value] of Object.entries(record)) {
    if (PATH_BEARING_ROOTS.has(key) || NEVER_INSPECT_KEYS.has(key)) continue
    if (typeof value !== 'string' || !value.startsWith('/')) continue
    if (!containsOldPath(value, ctx.oldPaths)) continue
    unsupported += 1
    if (ctx.unsupportedReferences.length < limit) {
      ctx.unsupportedReferences.push({
        location: `${ctx.location ?? 'record'} · ${key}`,
        reason: `Unknown field "${key}" references an old path; left unchanged`,
      })
    }
  }
  return { rewrittenFields, unsupported, changed: rewrittenFields > 0 }
}

export interface RewriteTranscriptResult {
  records: number
  rewrittenFields: number
  unsupported: number
  invalidLines: number
}

export interface RewriteTranscriptOptions {
  oldPaths: readonly string[]
  signal?: AbortSignal
  unsupportedReferences?: UnsupportedReferenceRecord[]
  /** Label used for report locations (defaults to the source basename). */
  label?: string
}

/**
 * Streams `srcFile` to `destFile` (atomically, via the ScopedFs) rewriting only the path-bearing
 * fields. Invalid lines and untouched records are copied verbatim; rewritten records are
 * re-serialised with JSON.stringify, which preserves key order.
 */
export async function rewriteTranscript(
  srcFile: string,
  destFile: string,
  mapPath: MapPath,
  scoped: ScopedFs,
  options: RewriteTranscriptOptions,
): Promise<RewriteTranscriptResult> {
  const result: RewriteTranscriptResult = {
    records: 0,
    rewrittenFields: 0,
    unsupported: 0,
    invalidLines: 0,
  }
  const label = options.label ?? srcFile.split('/').pop() ?? srcFile
  const ctx: RewriteContext = {
    oldPaths: options.oldPaths,
    unsupportedReferences: options.unsupportedReferences ?? [],
  }
  await writeStreamAtomic(
    scoped,
    destFile,
    async (out) => {
      for await (const line of readJsonlLines(srcFile, {
        ...(options.signal ? { signal: options.signal } : {}),
      })) {
        if (!line.record) {
          if (line.text.trim() !== '') result.invalidLines += 1
          await writeChunk(out, `${line.text}\n`)
          continue
        }
        result.records += 1
        ctx.location = `${label}:${line.lineNumber}`
        const r = rewriteRecordPaths(line.record, mapPath, ctx)
        result.rewrittenFields += r.rewrittenFields
        result.unsupported += r.unsupported
        await writeChunk(out, r.changed ? `${JSON.stringify(line.record)}\n` : `${line.text}\n`)
      }
    },
    { ...(options.signal ? { signal: options.signal } : {}) },
  )
  return result
}

export interface CountPathFieldsResult {
  records: number
  pathFields: number
  unsupported: number
  truncated: boolean
}

/** Dry-run of rewriteRecordPaths over (a bounded prefix of) a transcript; nothing is written. */
export async function countPathFields(
  file: string,
  mapPath: MapPath,
  options: RewriteTranscriptOptions & { maxRecords?: number },
): Promise<CountPathFieldsResult> {
  const result: CountPathFieldsResult = {
    records: 0,
    pathFields: 0,
    unsupported: 0,
    truncated: false,
  }
  const label = options.label ?? file.split('/').pop() ?? file
  const ctx: RewriteContext = {
    oldPaths: options.oldPaths,
    unsupportedReferences: options.unsupportedReferences ?? [],
  }
  const maxRecords = options.maxRecords
  for await (const line of readJsonlLines(file, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(maxRecords !== undefined ? { maxRecords: maxRecords + 1 } : {}),
  })) {
    if (!line.record) continue
    if (maxRecords !== undefined && result.records >= maxRecords) {
      result.truncated = true
      break
    }
    result.records += 1
    ctx.location = `${label}:${line.lineNumber}`
    const r = rewriteRecordPaths(line.record, mapPath, ctx)
    result.pathFields += r.rewrittenFields
    result.unsupported += r.unsupported
  }
  return result
}
