/**
 * Streaming, atomic file writes that stay inside a ScopedFs allow-list.
 *
 * ScopedFs only offers buffer-based atomic writes; transcripts can be tens of megabytes, so this
 * helper streams into a temp file in the destination directory (after `assertAllowed`), fsyncs,
 * and renames through the ScopedFs. Every destination path is still authorised by the ScopedFs.
 */
import { createReadStream, createWriteStream, promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Writable } from 'node:stream'
import { MigrationError, isAbortError, type ScopedFs } from '@devmig/shared'

export interface AtomicWriteOptions {
  mode?: number
  signal?: AbortSignal
}

/** Rethrows AbortErrors as CANCELLED MigrationErrors; passes MigrationErrors through; wraps the rest as IO_ERROR. */
export function toMigrationError(
  err: unknown,
  message: string,
  details?: Record<string, unknown>,
): MigrationError {
  if (err instanceof MigrationError) return err
  if (isAbortError(err)) {
    return new MigrationError('CANCELLED', 'The operation was cancelled.', { recoverable: true })
  }
  const nodeCode = (err as NodeJS.ErrnoException | undefined)?.code
  const code =
    nodeCode === 'EACCES' || nodeCode === 'EPERM'
      ? 'PERMISSION_DENIED'
      : nodeCode === 'ENOENT'
        ? 'PATH_NOT_FOUND'
        : nodeCode === 'ENOSPC'
          ? 'DISK_FULL'
          : 'IO_ERROR'
  return new MigrationError(code, message, { details, cause: err })
}

function tempPathFor(dest: string): string {
  return path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.devmig-tmp`,
  )
}

/**
 * Writes `dest` atomically by streaming into a sibling temp file. `produce` receives a writable and
 * must resolve when everything has been written (the stream is ended by this helper).
 */
export async function writeStreamAtomic(
  scoped: ScopedFs,
  dest: string,
  produce: (out: Writable) => Promise<void>,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const target = await scoped.assertAllowed(dest)
  await scoped.mkdir(path.dirname(target))
  const tmp = tempPathFor(target)
  await scoped.assertAllowed(tmp)
  const out = createWriteStream(tmp, { flags: 'w', mode: options.mode ?? 0o600 })
  const errors: Error[] = []
  out.once('error', (err) => {
    errors.push(err)
  })
  const rethrow = (): void => {
    const first = errors[0]
    if (first) throw first
  }
  try {
    await produce(out)
    rethrow()
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject)
      out.end(() => resolve())
    })
    rethrow()
    const handle = await fs.open(tmp, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await scoped.rename(tmp, target)
  } catch (err) {
    out.destroy()
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw toMigrationError(err, `Failed to write ${target}`, { path: target })
  }
}

/** Streams a file copy through writeStreamAtomic (temp + fsync + rename). Never follows symlinks on the source. */
export async function copyFileAtomic(
  scoped: ScopedFs,
  src: string,
  dest: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeStreamAtomic(
    scoped,
    dest,
    async (out) => {
      const input = createReadStream(src, options.signal ? { signal: options.signal } : {})
      await pipeline(input, out, { end: false })
    },
    options,
  )
}

/** Writes a string/Buffer atomically through the ScopedFs (small files). */
export async function writeTextAtomic(
  scoped: ScopedFs,
  dest: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await scoped.writeFileAtomic(dest, data, mode)
}

/** Writes a writable stream chunk and waits for drain when needed. */
export function writeChunk(out: Writable, chunk: string | Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ok = out.write(chunk, (err) => {
      if (err) reject(err)
    })
    if (ok) {
      resolve()
    } else {
      out.once('drain', resolve)
      out.once('error', reject)
    }
  })
}

/** Serialises a JSON value with the two-space layout Claude Code uses for its own files. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Returns a filesystem-safe timestamp for backup file names (e.g. 2026-08-28T10-00-00.000Z). */
export function fileTimestamp(now: Date): string {
  return now.toISOString().replace(/:/g, '-')
}

/** True when the directory exists (symlinks are not followed for the existence check). */
export async function isExistingDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function isExistingFile(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isFile()
  } catch {
    return false
  }
}

/** Reads a JSON file that may not exist; returns `undefined` when missing. Throws MigrationError on parse errors. */
export async function readOptionalJson(p: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(p, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw toMigrationError(err, `Cannot read ${p}`, { path: p })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new MigrationError('INVALID_INPUT', `${p} is not valid JSON`, {
      details: { path: p },
      cause: err,
    })
  }
}

/** Lists the direct child entries of a directory, or [] when it does not exist. */
export async function listDirectory(p: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(p, { withFileTypes: true })
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === 'ENOENT' ||
      (err as NodeJS.ErrnoException).code === 'ENOTDIR'
    ) {
      return []
    }
    throw toMigrationError(err, `Cannot list ${p}`, { path: p })
  }
}

export { createReadStream, createWriteStream }
