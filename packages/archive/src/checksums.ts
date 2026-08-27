/**
 * checksums.json: SHA-256 + size of every file in the payload (except itself), sorted by path.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Checksums as ChecksumsSchema, type ChecksumEntry, type Checksums } from '@devmig/model'
import { MigrationError, hashFile, isSafeArchivePath, throwIfAborted } from '@devmig/shared'
import type { ErrorCode } from '@devmig/model'
import { CHECKSUMS_ENTRY } from './constants'
import { integrity, invalid } from './errors'
import { createProgressReporter } from './progress'
import { comparePosixPaths, walkTree } from './tree'
import type { ArchiveProgress } from './types'

export interface ComputeChecksumsOptions {
  /** POSIX relative paths to leave out. checksums.json is always excluded. */
  exclude?: string[]
  signal?: AbortSignal
  onProgress?: (p: ArchiveProgress) => void
}

/** Streams every regular file under rootDir through SHA-256. Symlinks are ignored (never packed). */
export async function computeChecksums(
  rootDir: string,
  opts: ComputeChecksumsOptions = {},
): Promise<Checksums> {
  const exclude = new Set<string>([CHECKSUMS_ENTRY, ...(opts.exclude ?? [])])
  const { entries } = await walkTree(rootDir, { signal: opts.signal })
  const files = entries.filter((e) => e.kind === 'file' && !exclude.has(e.path))
  const totalBytes = files.reduce((n, f) => n + f.size, 0)
  const progress = createProgressReporter(opts.onProgress, totalBytes)
  const out: ChecksumEntry[] = []
  let bytes = 0
  for (const file of files) {
    throwIfAborted(opts.signal)
    const { sha256, sizeBytes } = await hashFile(file.absolute, opts.signal)
    out.push({ path: file.path, sha256, sizeBytes })
    bytes += sizeBytes
    progress.report({ bytes, entries: out.length, message: `Hashing ${file.path}` })
  }
  progress.report({ bytes, entries: out.length, message: 'Checksums computed' }, true)
  out.sort((a, b) => comparePosixPaths(a.path, b.path))
  return { algorithm: 'sha256', entries: out }
}

/** Computes checksums for rootDir and atomically writes `<rootDir>/checksums.json`. */
export async function writeChecksumsFile(rootDir: string): Promise<Checksums> {
  const checksums = await computeChecksums(rootDir)
  const target = path.join(rootDir, CHECKSUMS_ENTRY)
  const tmp = path.join(rootDir, `.${CHECKSUMS_ENTRY}.${process.pid}.${Date.now()}.tmp`)
  const handle = await fs.open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(checksums, null, 2))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, target)
  return checksums
}

/** Parses and validates checksums.json from untrusted bytes. */
export function parseChecksums(
  data: Buffer | string,
  code: ErrorCode = 'ARCHIVE_INVALID',
): Checksums {
  let raw: unknown
  try {
    raw = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) as unknown
  } catch {
    throw new MigrationError(code, 'checksums.json is not valid JSON.')
  }
  const parsed = ChecksumsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new MigrationError(code, 'checksums.json is malformed.', {
      details: {
        issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    })
  }
  const seen = new Set<string>()
  for (const entry of parsed.data.entries) {
    if (!isSafeArchivePath(entry.path) || entry.path.includes('\\')) {
      throw new MigrationError(code, `checksums.json contains an unsafe path: ${entry.path}`)
    }
    if (entry.path === CHECKSUMS_ENTRY) {
      throw new MigrationError(code, 'checksums.json must not list itself.')
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new MigrationError(code, `checksums.json contains an invalid digest for ${entry.path}`)
    }
    if (seen.has(entry.path)) {
      throw new MigrationError(code, `checksums.json lists ${entry.path} twice.`)
    }
    seen.add(entry.path)
  }
  return parsed.data
}

export interface VerifyChecksumsOptions {
  signal?: AbortSignal
  onProgress?: (p: ArchiveProgress) => void
}

/**
 * Verifies an extracted tree against checksums.json: every listed file must exist with the same
 * size and digest (INTEGRITY_MISMATCH otherwise) and no unlisted file may exist (ARCHIVE_INVALID).
 */
export async function verifyChecksumsAgainstDir(
  rootDir: string,
  checksums: Checksums,
  opts: VerifyChecksumsOptions = {},
): Promise<{ files: number; bytes: number }> {
  const expected = new Map(checksums.entries.map((e) => [e.path, e] as const))
  const { entries } = await walkTree(rootDir, { signal: opts.signal })
  const files = entries.filter((e) => e.kind === 'file' && e.path !== CHECKSUMS_ENTRY)
  const totalBytes = files.reduce((n, f) => n + f.size, 0)
  const progress = createProgressReporter(opts.onProgress, totalBytes)
  let bytes = 0
  for (const file of files) {
    throwIfAborted(opts.signal)
    const want = expected.get(file.path)
    if (!want)
      throw invalid(`Unexpected file not listed in checksums.json: ${file.path}`, {
        path: file.path,
      })
    if (file.size !== want.sizeBytes) {
      throw integrity(`Size mismatch for ${file.path}`, {
        path: file.path,
        expected: want.sizeBytes,
        actual: file.size,
      })
    }
    const { sha256 } = await hashFile(file.absolute, opts.signal)
    if (sha256 !== want.sha256) {
      throw integrity(`Checksum mismatch for ${file.path}`, { path: file.path })
    }
    expected.delete(file.path)
    bytes += file.size
    progress.report({
      bytes,
      entries: files.length - expected.size,
      message: `Verified ${file.path}`,
    })
  }
  if (expected.size > 0) {
    const missing = [...expected.keys()].slice(0, 10)
    throw integrity(`${expected.size} file(s) listed in checksums.json are missing.`, { missing })
  }
  progress.report({ bytes, entries: files.length, message: 'Checksums verified' }, true)
  return { files: files.length, bytes }
}
