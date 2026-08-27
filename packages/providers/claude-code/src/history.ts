/**
 * history.jsonl helpers (research §9): filter rows to a set of project paths, dedupe by
 * (sessionId, timestamp), and remap the `project` field.
 */
import { canonicalizePath } from '@devmig/shared'
import { HistoryRowSchema, type HistoryRow } from './schema'
import { readJsonlLines, type JsonRecord } from './transcript'

export function historyRowKey(row: HistoryRow): string | null {
  if (typeof row.sessionId !== 'string' || typeof row.timestamp !== 'number') return null
  return `${row.sessionId}|${row.timestamp}`
}

/** True when `candidate` equals `prefix` or lives inside it (both canonicalized). */
export function isSamePathOrChild(prefix: string, candidate: string): boolean {
  const p = canonicalizePath(prefix)
  const c = canonicalizePath(candidate)
  return c === p || c.startsWith(`${p}/`)
}

export function historyRowMatchesPaths(row: HistoryRow, paths: readonly string[]): boolean {
  if (typeof row.project !== 'string' || row.project.length === 0) return false
  return paths.some((p) => isSamePathOrChild(p, row.project as string))
}

export interface HistoryLine {
  text: string
  record: JsonRecord
  row: HistoryRow
}

/** Streams history.jsonl yielding parsed rows whose `project` is one of the given paths (or a child). */
export async function* readHistoryRows(
  file: string,
  options: { paths?: readonly string[]; signal?: AbortSignal } = {},
): AsyncGenerator<HistoryLine> {
  for await (const line of readJsonlLines(file, {
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    if (!line.record) continue
    const parsed = HistoryRowSchema.safeParse(line.record)
    if (!parsed.success) continue
    if (options.paths && !historyRowMatchesPaths(parsed.data, options.paths)) continue
    yield { text: line.text, record: line.record, row: parsed.data }
  }
}

/** Collects the dedupe keys of an existing history file (missing file -> empty set). */
export async function readHistoryKeys(file: string, signal?: AbortSignal): Promise<Set<string>> {
  const keys = new Set<string>()
  try {
    for await (const line of readHistoryRows(file, signal ? { signal } : {})) {
      const key = historyRowKey(line.row)
      if (key) keys.add(key)
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'PATH_NOT_FOUND') return keys
    if ((err as { cause?: { code?: string } }).cause?.code === 'ENOENT') return keys
    throw err
  }
  return keys
}
