import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { Checksums, Manifest } from '@devmig/model'
import { noopLogger, throwIfAborted } from '@devmig/shared'
import { parseChecksums } from './checksums'
import {
  CHECKSUMS_ENTRY,
  MANIFEST_ENTRY,
  MAX_CHECKSUMS_BYTES,
  MAX_MANIFEST_BYTES,
} from './constants'
import { EntryGuard } from './entry-guard'
import { cancelled, integrity, invalid, toMigrationError } from './errors'
import { parseManifest } from './manifest'
import { createPayloadDecryptor, createPayloadSource, openDevBackup } from './open'
import { createProgressReporter } from './progress'
import { collectEntry, createTarSink } from './tar-sink'
import type { VerifyDevBackupOptions, VerifyDevBackupResult } from './types'

interface Observed {
  sha256: string
  sizeBytes: number
}

/**
 * Streams through the whole archive without writing anything: every chunk is authenticated,
 * every file entry is hashed and compared with checksums.json (the last entry).
 */
export async function verifyDevBackup(
  opts: VerifyDevBackupOptions,
): Promise<VerifyDevBackupResult> {
  const logger = opts.logger ?? noopLogger
  const { signal } = opts
  const opened = await openDevBackup(opts.path, opts.password, { signal, logger })
  const guard = new EntryGuard(opts.limits)
  const progress = createProgressReporter(opts.onProgress, opened.plaintextBytes)
  const observed = new Map<string, Observed>()
  let manifest: Manifest | undefined
  let checksums: Checksums | undefined
  let bytes = 0
  let entries = 0

  const sink = createTarSink({
    logger,
    onEntry: (entry) => {
      throwIfAborted(signal)
      const accepted = guard.accept(entry.path, entry.type, entry.size)
      entries += 1
      if (accepted.kind === 'Directory') {
        entry.resume()
        return
      }
      if (!accepted.isManifest && !manifest) {
        throw invalid(`${MANIFEST_ENTRY} must be validated before other entries.`)
      }
      if (accepted.isManifest) {
        return collectEntry(entry, MAX_MANIFEST_BYTES, MANIFEST_ENTRY).then((buf) => {
          manifest = parseManifest(buf, opened.header)
          observed.set(accepted.path, {
            sha256: createHash('sha256').update(buf).digest('hex'),
            sizeBytes: buf.length,
          })
          bytes += buf.length
        })
      }
      if (accepted.isChecksums) {
        return collectEntry(entry, MAX_CHECKSUMS_BYTES, CHECKSUMS_ENTRY).then((buf) => {
          checksums = parseChecksums(buf, 'ARCHIVE_INVALID')
          bytes += buf.length
        })
      }
      const hash = createHash('sha256')
      let size = 0
      return new Promise<void>((resolve, reject) => {
        entry.on('data', (chunk: Buffer) => {
          hash.update(chunk)
          size += chunk.length
        })
        entry.once('error', (err: unknown) => reject(toMigrationError(err, 'ARCHIVE_INVALID')))
        entry.once('end', () => {
          if (size !== accepted.size) {
            reject(
              invalid(`Entry body size mismatch for ${accepted.path}`, {
                expected: accepted.size,
                actual: size,
              }),
            )
            return
          }
          observed.set(accepted.path, { sha256: hash.digest('hex'), sizeBytes: size })
          bytes += size
          progress.report({ bytes, entries, message: `Verified ${accepted.path}` })
          resolve()
        })
      })
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
  } finally {
    opened.contentKey.fill(0)
  }
  guard.finish()
  if (!manifest) throw invalid(`The archive contains no ${MANIFEST_ENTRY}.`)
  if (!checksums) throw invalid(`The archive contains no ${CHECKSUMS_ENTRY}.`)

  const expected = new Map(checksums.entries.map((e) => [e.path, e] as const))
  for (const [p, seen] of observed) {
    const want = expected.get(p)
    if (!want) throw invalid(`File not listed in ${CHECKSUMS_ENTRY}: ${p}`, { path: p })
    if (want.sizeBytes !== seen.sizeBytes) {
      throw integrity(`Size mismatch for ${p}`, {
        path: p,
        expected: want.sizeBytes,
        actual: seen.sizeBytes,
      })
    }
    if (want.sha256 !== seen.sha256) throw integrity(`Checksum mismatch for ${p}`, { path: p })
    expected.delete(p)
  }
  if (expected.size > 0) {
    throw integrity(
      `${expected.size} file(s) listed in ${CHECKSUMS_ENTRY} are missing from the archive.`,
      {
        missing: [...expected.keys()].slice(0, 10),
      },
    )
  }
  progress.report({ bytes, entries, message: 'Verification complete' }, true)
  logger.info('Backup verified', { path: opts.path, entries, bytes })
  return { header: opened.header, manifest, entries, bytes, ok: true }
}
