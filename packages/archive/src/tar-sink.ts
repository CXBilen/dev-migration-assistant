/**
 * Wraps node-tar's `Parser` in a Node `Writable` so it can terminate a `stream.pipeline`, with
 * strict backpressure and a single failure channel.
 *
 * Entry handling is delegated to a callback that must consume each entry synchronously (pipe it,
 * hash it or resume it) and return a promise that settles when the entry is fully committed.
 * Commits of entries that already ended are awaited after every chunk, so at most one chunk's
 * worth of entries is ever in flight.
 *
 * First-entry barrier: the first 512-byte block must be the ustar header of `manifest.json`; only
 * that entry (header + padded body) is fed to the parser and its commit is awaited before any
 * further byte is parsed. This is what lets callers validate the manifest before accepting any
 * other entry, and it also defeats node-tar's automatic gzip/zstd sniffing (a bomb vector).
 */
import { Writable } from 'node:stream'
import { Header, Parser, type ReadEntry } from 'tar'
import { MigrationError, type Logger, noopLogger } from '@devmig/shared'
import { MANIFEST_ENTRY, MAX_MANIFEST_BYTES } from './constants'
import { invalid, limitExceeded, toMigrationError } from './errors'

export type TarEntryHandler = (entry: ReadEntry) => Promise<void> | void

export interface TarSinkOptions {
  onEntry: TarEntryHandler
  logger?: Logger
  highWaterMark?: number
}

export interface TarSink extends Writable {
  /** Aborts parsing with the given error; the pipeline rejects with it. Idempotent. */
  fail(err: MigrationError): void
  readonly failure: MigrationError | undefined
  /**
   * Resolves once every entry commit has settled (fulfilled or failed). Callers must await this
   * after the pipeline ends — especially after a failure — before touching the destination.
   */
  settle(): Promise<void>
}

const BLOCK = 512
const FIRST_HEADER_PREFIX = Buffer.from(`${MANIFEST_ENTRY}\0`, 'utf8')

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function createTarSink(opts: TarSinkOptions): TarSink {
  const logger = opts.logger ?? noopLogger
  const parser = new Parser({
    strict: true,
    brotli: false,
    zstd: false,
    onwarn: (code, message) => logger.warn('tar warning', { code, message }),
  })
  let failure: MigrationError | undefined
  let drain: Deferred | undefined
  /** Bytes of the first entry (header + padded body) still to be fed before the barrier lifts. */
  let barrierRemaining: number | undefined
  let barrierDone = false
  let pending: Buffer | undefined
  const active = new Set<Promise<void>>()
  const activeEntries = new Set<ReadEntry>()
  const ended: Promise<void>[] = []

  const fail = (err: MigrationError): void => {
    if (failure) return
    failure = err
    parser.abort(err)
    // Entries still streaming can never complete now: fail their consumers so commits settle.
    for (const entry of [...activeEntries]) entry.destroy(err)
    activeEntries.clear()
    drain?.reject(err)
    drain = undefined
  }

  parser.on('error', (err: unknown) => {
    if (!failure) failure = toMigrationError(err, 'ARCHIVE_INVALID')
    drain?.reject(failure)
    drain = undefined
  })
  parser.on('drain', () => {
    drain?.resolve()
    drain = undefined
  })

  parser.on('entry', (entry: ReadEntry) => {
    // Every entry gets an error listener so destroy(err) never throws as an unhandled 'error'.
    entry.on('error', () => undefined)
    if (failure) {
      entry.resume()
      return
    }
    activeEntries.add(entry)
    entry.once('end', () => activeEntries.delete(entry))
    let result: Promise<void> | void
    try {
      result = opts.onEntry(entry)
    } catch (err) {
      fail(toMigrationError(err, 'ARCHIVE_INVALID'))
      entry.resume()
      return
    }
    const commit: Promise<void> = Promise.resolve(result).then(
      () => undefined,
      (err: unknown) => {
        fail(toMigrationError(err, 'ARCHIVE_INVALID'))
      },
    )
    active.add(commit)
    void commit.finally(() => active.delete(commit))
    entry.once('end', () => ended.push(commit))
  })

  /** Feeds bytes to the parser, honours backpressure, then awaits commits of entries that ended. */
  const throwIfFailed = (): void => {
    const current = failure
    if (current) throw current
  }

  const feed = async (chunk: Buffer): Promise<void> => {
    if (chunk.length === 0) return
    const ok = parser.write(chunk)
    throwIfFailed()
    if (!ok) {
      drain = deferred()
      await drain.promise
    }
    await Promise.all(ended.splice(0))
    throwIfFailed()
  }

  const consume = async (chunk: Buffer): Promise<void> => {
    if (barrierDone) {
      await feed(chunk)
      return
    }
    pending = pending ? Buffer.concat([pending, chunk]) : chunk
    if (barrierRemaining === undefined) {
      if (pending.length < BLOCK) return
      if (!pending.subarray(0, FIRST_HEADER_PREFIX.length).equals(FIRST_HEADER_PREFIX)) {
        throw invalid(`The payload does not start with a ${MANIFEST_ENTRY} entry.`)
      }
      let header: Header
      try {
        header = new Header(pending.subarray(0, BLOCK))
      } catch (err) {
        throw invalid('The first tar header is malformed.', { cause: String(err) })
      }
      if (!header.cksumValid || header.type !== 'File' || header.path !== MANIFEST_ENTRY) {
        throw invalid(`The first entry must be a regular file named ${MANIFEST_ENTRY}.`)
      }
      const size = header.size ?? 0
      if (!Number.isSafeInteger(size) || size < 0) throw invalid('Invalid manifest.json size.')
      if (size > MAX_MANIFEST_BYTES) {
        throw limitExceeded(`${MANIFEST_ENTRY} is larger than ${MAX_MANIFEST_BYTES} bytes.`, {
          size,
        })
      }
      barrierRemaining = BLOCK + Math.ceil(size / BLOCK) * BLOCK
    }
    if (pending.length < barrierRemaining) return
    const first = pending.subarray(0, barrierRemaining)
    const rest = pending.subarray(barrierRemaining)
    pending = undefined
    barrierDone = true
    await feed(first)
    if (rest.length > 0) await feed(rest)
  }

  class Sink extends Writable {
    get failure(): MigrationError | undefined {
      return failure
    }
    fail(err: MigrationError): void {
      fail(err)
    }
    settle(): Promise<void> {
      return Promise.all([...active]).then(() => undefined)
    }
    override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
      if (failure) {
        cb(failure)
        return
      }
      consume(chunk).then(
        () => cb(failure ?? null),
        (err: unknown) => {
          const mapped = toMigrationError(err, 'ARCHIVE_INVALID')
          fail(mapped)
          cb(failure ?? mapped)
        },
      )
    }
    override _final(cb: (err?: Error | null) => void): void {
      if (failure) {
        cb(failure)
        return
      }
      if (!barrierDone) {
        fail(invalid('The payload ended before the manifest.json entry was complete.'))
        cb(failure)
        return
      }
      const closed = new Promise<void>((resolve, reject) => {
        parser.once('close', () => resolve())
        parser.once('error', (err: unknown) => reject(toMigrationError(err, 'ARCHIVE_INVALID')))
      })
      parser.end()
      closed
        .then(() => Promise.all([...active]))
        .then(
          () => cb(failure ?? null),
          (err: unknown) => cb(failure ?? toMigrationError(err, 'ARCHIVE_INVALID')),
        )
    }
    override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
      if (err) fail(toMigrationError(err))
      cb(err)
    }
  }
  return new Sink({ highWaterMark: opts.highWaterMark ?? 1024 * 1024 })
}

/** Collects a bounded entry body in memory. Attaches its consumer synchronously. */
export function collectEntry(entry: ReadEntry, maxBytes: number, label: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = []
    let length = 0
    let failed = false
    entry.on('data', (chunk: Buffer) => {
      if (failed) return
      length += chunk.length
      if (length > maxBytes) {
        failed = true
        reject(
          new MigrationError(
            'ARCHIVE_LIMIT_EXCEEDED',
            `${label} is larger than ${maxBytes} bytes.`,
            {
              details: { max: maxBytes },
            },
          ),
        )
        return
      }
      parts.push(chunk)
    })
    entry.once('end', () => {
      if (!failed) resolve(Buffer.concat(parts, length))
    })
    entry.once('error', (err: unknown) => {
      failed = true
      reject(toMigrationError(err, 'ARCHIVE_INVALID'))
    })
  })
}
