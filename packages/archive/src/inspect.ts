import { pipeline } from 'node:stream/promises'
import type { Manifest } from '@devmig/model'
import { noopLogger } from '@devmig/shared'
import { MANIFEST_ENTRY, MAX_MANIFEST_BYTES } from './constants'
import { EntryGuard } from './entry-guard'
import { cancelled, invalid, toMigrationError } from './errors'
import { parseManifest } from './manifest'
import { createPayloadDecryptor, createPayloadSource, openDevBackup } from './open'
import { collectEntry, createTarSink } from './tar-sink'
import type { InspectDevBackupOptions, InspectDevBackupResult } from './types'

/**
 * Decrypts just enough of the payload to read and validate manifest.json (the first entry), then
 * stops. Nothing is extracted or written.
 */
export async function inspectDevBackup(
  opts: InspectDevBackupOptions,
): Promise<InspectDevBackupResult> {
  const logger = opts.logger ?? noopLogger
  const opened = await openDevBackup(opts.path, opts.password, { signal: opts.signal, logger })
  const stop = new AbortController()
  const signals: AbortSignal[] = [stop.signal]
  if (opts.signal) signals.push(opts.signal)
  const combined = AbortSignal.any(signals)
  const guard = new EntryGuard()
  let manifest: Manifest | undefined
  let bytesRead = 0
  let manifestSeen = false
  const sink = createTarSink({
    logger,
    onEntry: (entry) => {
      if (manifestSeen) {
        // Everything after the manifest is irrelevant here; the pipeline is being stopped.
        entry.resume()
        return
      }
      // The guard enforces that the first entry is the regular file manifest.json.
      guard.accept(entry.path, entry.type, entry.size)
      manifestSeen = true
      const body = collectEntry(entry, MAX_MANIFEST_BYTES, MANIFEST_ENTRY)
      return body.then((buf) => {
        manifest = parseManifest(buf, opened.header)
        stop.abort()
      })
    },
  })
  try {
    await pipeline(
      createPayloadSource(opened, { onRead: (n) => (bytesRead = n) }),
      createPayloadDecryptor(opened),
      sink,
      { signal: combined },
    )
  } catch (err) {
    await sink.settle()
    if (opts.signal?.aborted) throw cancelled()
    if (!(manifest && stop.signal.aborted))
      throw sink.failure ?? toMigrationError(err, 'ARCHIVE_INVALID')
  } finally {
    opened.contentKey.fill(0)
  }
  await sink.settle()
  if (!manifest) throw invalid(`The archive contains no ${MANIFEST_ENTRY}.`)
  return { header: opened.header, manifest, sizeBytes: opened.sizeBytes, bytesRead }
}
