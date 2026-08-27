/**
 * Integrity verification of an extracted payload against its `checksums.json` (ADR-0003).
 * Streams every file through SHA-256; never loads a payload into memory.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Checksums as ChecksumsSchema, type Checksums } from '@devmig/model'
import { MigrationError, hashFile, throwIfAborted, toPosix, walkFiles } from '@devmig/shared'

export const CHECKSUMS_FILE_NAME = 'checksums.json'

export type IntegrityIssueKind = 'missing' | 'mismatch' | 'size' | 'extra'

export interface IntegrityIssue {
  path: string
  kind: IntegrityIssueKind
  detail: string
}

export interface IntegrityReport {
  ok: boolean
  /** Files that matched their checksum entry. */
  verified: number
  issues: IntegrityIssue[]
}

export interface VerifyPayloadOptions {
  signal?: AbortSignal
  /** Report files present on disk but absent from checksums.json (default true). */
  reportExtraFiles?: boolean
}

/** Reads and validates `<payloadRoot>/checksums.json`. */
export async function readChecksumsFile(payloadRoot: string): Promise<Checksums> {
  const file = path.join(payloadRoot, CHECKSUMS_FILE_NAME)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    throw new MigrationError('ARCHIVE_INVALID', 'The payload does not contain checksums.json.', {
      details: { file },
      cause: err,
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new MigrationError('ARCHIVE_INVALID', 'checksums.json is not valid JSON.', {
      details: { file },
      cause: err,
    })
  }
  const result = ChecksumsSchema.safeParse(parsed)
  if (!result.success) {
    throw new MigrationError('ARCHIVE_INVALID', 'checksums.json has an invalid structure.', {
      details: { issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    })
  }
  return result.data
}

/**
 * Compares every file under payloadRoot with checksums.json. Returns a report instead of throwing so
 * callers can decide whether a mismatch is fatal (restore) or informational (diagnostics).
 */
export async function verifyPayloadChecksums(
  payloadRoot: string,
  options: VerifyPayloadOptions = {},
): Promise<IntegrityReport> {
  const checksums = await readChecksumsFile(payloadRoot)
  const expected = new Map(checksums.entries.map((e) => [e.path, e]))
  const issues: IntegrityIssue[] = []
  const seen = new Set<string>()
  let verified = 0
  for await (const entry of walkFiles(payloadRoot, { signal: options.signal })) {
    throwIfAborted(options.signal)
    const rel = toPosix(entry.relativePath)
    if (rel === CHECKSUMS_FILE_NAME) continue
    if (!entry.dirent.isFile()) {
      issues.push({ path: rel, kind: 'extra', detail: 'Not a regular file' })
      continue
    }
    const want = expected.get(rel)
    if (!want) {
      if (options.reportExtraFiles !== false) {
        issues.push({ path: rel, kind: 'extra', detail: 'File is not listed in checksums.json' })
      }
      continue
    }
    seen.add(rel)
    const { sha256, sizeBytes } = await hashFile(entry.absolutePath, options.signal)
    if (sizeBytes !== want.sizeBytes) {
      issues.push({
        path: rel,
        kind: 'size',
        detail: `Expected ${want.sizeBytes} bytes, found ${sizeBytes}`,
      })
      continue
    }
    if (sha256 !== want.sha256) {
      issues.push({ path: rel, kind: 'mismatch', detail: 'SHA-256 does not match checksums.json' })
      continue
    }
    verified += 1
  }
  for (const [rel] of expected) {
    if (!seen.has(rel)) {
      issues.push({ path: rel, kind: 'missing', detail: 'Listed in checksums.json but not found' })
    }
  }
  return { ok: issues.length === 0, verified, issues }
}

/** Throws INTEGRITY_MISMATCH when the payload does not match checksums.json. */
export async function assertPayloadIntegrity(
  payloadRoot: string,
  options: VerifyPayloadOptions = {},
): Promise<IntegrityReport> {
  const report = await verifyPayloadChecksums(payloadRoot, options)
  if (!report.ok) {
    const first = report.issues[0]
    throw new MigrationError(
      'INTEGRITY_MISMATCH',
      `The backup payload failed integrity verification (${report.issues.length} issue(s)); first: ${first?.path ?? '?'} ${first?.detail ?? ''}`.trim(),
      {
        hint: 'The backup file may be corrupted or tampered with. Nothing was restored.',
        details: { issues: report.issues.slice(0, 50) },
      },
    )
  }
  return report
}
