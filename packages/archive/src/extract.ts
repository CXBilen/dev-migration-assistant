import { createWriteStream, mkdirSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Checksums, Manifest } from '@devmig/model'
import {
  MigrationError,
  isPathWithin,
  noopLogger,
  throwIfAborted,
  type Logger,
} from '@devmig/shared'
import type { ReadEntry } from 'tar'
import { parseChecksums, verifyChecksumsAgainstDir } from './checksums'
import {
  CHECKSUMS_ENTRY,
  EXTRACT_TEMP_SUFFIX,
  MANIFEST_ENTRY,
  MAX_CHECKSUMS_BYTES,
  MAX_MANIFEST_BYTES,
} from './constants'
import { EntryGuard } from './entry-guard'
import { cancelled, entryRejected, invalid, toMigrationError } from './errors'
import { parseManifest } from './manifest'
import { createPayloadDecryptor, createPayloadSource, openDevBackup } from './open'
import { createProgressReporter } from './progress'
import { collectEntry, createTarSink } from './tar-sink'
import { walkTree } from './tree'
import type { ExtractDevBackupOptions, ExtractDevBackupResult } from './types'

/** Ensures destinationDir is an empty directory we own; creates it (0700) when missing. */
async function prepareDestination(dest: string): Promise<{ created: boolean }> {
  let stat
  try {
    stat = await fs.lstat(dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw toMigrationError(err)
    try {
      await fs.mkdir(dest, { recursive: true, mode: 0o700 })
    } catch (mkErr) {
      throw toMigrationError(mkErr)
    }
    return { created: true }
  }
  if (stat.isSymbolicLink()) {
    throw new MigrationError('INVALID_INPUT', 'The destination must not be a symbolic link.', {
      details: { path: dest },
    })
  }
  if (!stat.isDirectory()) {
    throw new MigrationError('NOT_A_DIRECTORY', `The destination is not a directory: ${dest}`, {
      details: { path: dest },
    })
  }
  const names = await fs.readdir(dest)
  if (names.length > 0) {
    throw new MigrationError(
      'RESTORE_DESTINATION_EXISTS',
      `The destination directory is not empty: ${dest}`,
      {
        hint: 'Extraction only targets an empty directory so nothing existing can be overwritten.',
        details: { path: dest, entries: names.length },
      },
    )
  }
  return { created: false }
}

async function cleanupDestination(dest: string, created: boolean, logger: Logger): Promise<void> {
  try {
    if (created) {
      await fs.rm(dest, { recursive: true, force: true, maxRetries: 3 })
      return
    }
    for (const name of await fs.readdir(dest)) {
      await fs.rm(path.join(dest, name), { recursive: true, force: true, maxRetries: 3 })
    }
  } catch (err) {
    logger.warn('Could not clean up extraction directory', { dest, error: String(err) })
  }
}

function fileMode(entry: ReadEntry): number {
  return ((typeof entry.mode === 'number' ? entry.mode : 0o644) & 0o777) | 0o600
}

function dirMode(entry: ReadEntry | undefined): number {
  return ((typeof entry?.mode === 'number' ? entry.mode : 0o755) & 0o777) | 0o700
}

/** Writes a small in-memory body atomically (temp + fsync + rename). */
async function writeBufferAtomic(
  target: string,
  data: Buffer,
  mode: number,
  mtime: Date | undefined,
): Promise<void> {
  const tmp = `${target}${EXTRACT_TEMP_SUFFIX}`
  const handle = await fs.open(tmp, 'wx', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, target)
  if (mtime) await fs.utimes(target, mtime, mtime).catch(() => undefined)
}

/**
 * Streams a file entry to `<target>.devmig-partial` with fsync, then renames it into place.
 * The consumer is attached synchronously so no entry byte is ever buffered unobserved.
 */
function writeEntryAtomic(entry: ReadEntry, target: string, expectedSize: number): Promise<void> {
  const tmp = `${target}${EXTRACT_TEMP_SUFFIX}`
  const mode = fileMode(entry)
  const mtime = entry.mtime
  const ws = createWriteStream(tmp, { flags: 'wx', mode, flush: true })
  const finished = new Promise<void>((resolve, reject) => {
    ws.once('error', reject)
    ws.once('close', () => resolve())
    entry.once('error', (err: unknown) => {
      ws.destroy()
      reject(toMigrationError(err, 'ARCHIVE_INVALID'))
    })
  })
  entry.pipe(ws)
  return finished.then(
    async () => {
      const stat = await fs.stat(tmp)
      if (stat.size !== expectedSize) {
        throw invalid(`Entry body size mismatch for ${entry.path}`, {
          expected: expectedSize,
          actual: stat.size,
        })
      }
      await fs.rename(tmp, target)
      if (mtime) await fs.utimes(target, mtime, mtime).catch(() => undefined)
    },
    async (err: unknown) => {
      ws.destroy()
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    },
  )
}

/** Post-extraction defence in depth: no symlinks, every real path inside the destination. */
async function verifyContainment(realDest: string, signal: AbortSignal | undefined): Promise<void> {
  const { entries, skipped } = await walkTree(realDest, { signal })
  if (skipped.length > 0) {
    throw entryRejected('Unexpected non-regular file in the extraction directory.', {
      paths: skipped.slice(0, 10),
    })
  }
  for (const entry of entries) {
    throwIfAborted(signal)
    const real = await fs.realpath(entry.absolute)
    if (!isPathWithin(realDest, real)) {
      throw entryRejected(`Extracted path resolves outside the destination: ${entry.path}`, {
        path: entry.path,
        resolved: real,
      })
    }
  }
}

/**
 * Hardened extraction into an empty directory: manifest.json is validated before any other entry
 * is parsed, only regular files and directories are accepted, every path is validated, limits are
 * enforced, files are written atomically, and checksums.json is verified afterwards.
 * On any failure (including cancellation) the destination is emptied again.
 */
export async function extractDevBackup(
  opts: ExtractDevBackupOptions,
): Promise<ExtractDevBackupResult> {
  const logger = opts.logger ?? noopLogger
  const { signal } = opts
  const dest = path.resolve(opts.destinationDir)
  const { created } = await prepareDestination(dest)
  let opened
  try {
    opened = await openDevBackup(opts.path, opts.password, { signal, logger })
  } catch (err) {
    await cleanupDestination(dest, created, logger)
    throw err
  }
  const realDest = await fs.realpath(dest)
  const guard = new EntryGuard(opts.limits)
  const progress = createProgressReporter(opts.onProgress, opened.plaintextBytes)
  const createdDirs = new Set<string>()
  const ensureDir = (dir: string, mode: number): void => {
    if (createdDirs.has(dir)) return
    mkdirSync(dir, { recursive: true, mode })
    createdDirs.add(dir)
  }
  let manifest: Manifest | undefined
  let checksums: Checksums | undefined
  let bytes = 0
  let entries = 0

  const sink = createTarSink({
    logger,
    onEntry: (entry) => {
      throwIfAborted(signal)
      const accepted = guard.accept(entry.path, entry.type, entry.size)
      const target = path.join(realDest, ...accepted.path.split('/'))
      if (!isPathWithin(realDest, target) || target === realDest) {
        throw entryRejected(`Entry escapes the destination: ${accepted.path}`, {
          path: accepted.path,
        })
      }
      entries += 1
      if (accepted.kind === 'Directory') {
        ensureDir(target, dirMode(entry))
        entry.resume()
        return
      }
      if (!accepted.isManifest && !manifest) {
        throw invalid(`${MANIFEST_ENTRY} must be validated before other entries.`)
      }
      ensureDir(path.dirname(target), dirMode(undefined))
      const report = (): void => {
        bytes += accepted.size
        progress.report({ bytes, entries, message: `Extracted ${accepted.path}` })
      }
      if (accepted.isManifest) {
        return collectEntry(entry, MAX_MANIFEST_BYTES, MANIFEST_ENTRY).then(async (buf) => {
          manifest = parseManifest(buf, opened.header)
          await writeBufferAtomic(target, buf, fileMode(entry), entry.mtime)
          report()
        })
      }
      if (accepted.isChecksums) {
        return collectEntry(entry, MAX_CHECKSUMS_BYTES, CHECKSUMS_ENTRY).then(async (buf) => {
          checksums = parseChecksums(buf, 'ARCHIVE_INVALID')
          await writeBufferAtomic(target, buf, fileMode(entry), entry.mtime)
          report()
        })
      }
      return writeEntryAtomic(entry, target, accepted.size).then(report)
    },
  })

  try {
    try {
      await pipeline(createPayloadSource(opened), createPayloadDecryptor(opened), sink, { signal })
    } catch (err) {
      await sink.settle()
      if (signal?.aborted) throw cancelled()
      throw sink.failure ?? toMigrationError(err, 'ARCHIVE_INVALID')
    }
    await sink.settle()
    if (sink.failure) throw sink.failure
    guard.finish()
    if (!manifest) throw invalid(`The archive contains no ${MANIFEST_ENTRY}.`)
    if (!checksums) throw invalid(`The archive contains no ${CHECKSUMS_ENTRY}.`)
    throwIfAborted(signal)
    await verifyContainment(realDest, signal)
    let checksumsVerified = false
    if (opts.verifyChecksums !== false) {
      await verifyChecksumsAgainstDir(realDest, checksums, {
        signal,
        onProgress: opts.onProgress
          ? (p) => opts.onProgress?.({ ...p, message: p.message ?? 'Verifying checksums…' })
          : undefined,
      })
      checksumsVerified = true
    }
    progress.report({ bytes, entries, message: 'Extraction complete' }, true)
    logger.info('Backup extracted', { dest: realDest, entries, bytes, checksumsVerified })
    return { header: opened.header, manifest, entries, bytes, checksumsVerified }
  } catch (err) {
    await cleanupDestination(dest, created, logger)
    throw toMigrationError(err, 'ARCHIVE_INVALID')
  } finally {
    opened.contentKey.fill(0)
  }
}
