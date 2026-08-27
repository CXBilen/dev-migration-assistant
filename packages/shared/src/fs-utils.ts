import { createHash } from 'node:crypto'
import { createReadStream, promises as fs, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Streams a file through SHA-256 without loading it into memory. */
export async function hashFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256')
  let size = 0
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { signal })
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buf.length
      hash.update(buf)
    })
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return { sha256: hash.digest('hex'), sizeBytes: size }
}

export interface WalkEntry {
  absolutePath: string
  relativePath: string
  dirent: Dirent
  sizeBytes: number
}

export interface WalkOptions {
  /** Return false to skip a directory (and everything under it) or a file. Receives POSIX relative path. */
  filter?: (relativePath: string, dirent: Dirent) => boolean
  followSymlinks?: boolean
  signal?: AbortSignal
  maxEntries?: number
}

/** Recursively lists files (not directories). Symlinks are not followed by default and are yielded as-is. */
export async function* walkFiles(root: string, opts: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  let count = 0
  const stack: string[] = ['']
  while (stack.length > 0) {
    if (opts.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    const rel = stack.pop() as string
    const dir = path.join(root, rel)
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of entries) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
      if (opts.filter && !opts.filter(childRel, dirent)) continue
      const abs = path.join(root, childRel)
      if (dirent.isDirectory()) {
        stack.push(childRel)
      } else if (dirent.isFile() || (dirent.isSymbolicLink() && opts.followSymlinks)) {
        let size: number
        try {
          size = (await fs.stat(abs)).size
        } catch {
          continue
        }
        count += 1
        if (opts.maxEntries && count > opts.maxEntries)
          throw new Error(`Too many entries under ${root}`)
        yield { absolutePath: abs, relativePath: childRel, dirent, sizeBytes: size }
      } else if (dirent.isSymbolicLink()) {
        count += 1
        yield { absolutePath: abs, relativePath: childRel, dirent, sizeBytes: 0 }
      }
    }
  }
}

/** Sums file sizes under a directory using walkFiles and the same filter semantics. */
export async function dirSize(
  root: string,
  opts: WalkOptions = {},
): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  for await (const entry of walkFiles(root, opts)) {
    bytes += entry.sizeBytes
    files += 1
  }
  return { bytes, files }
}

/** Creates a private (0700) temporary directory. */
export async function makeTempDir(prefix = 'devmig-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  await fs.chmod(dir, 0o700)
  return dir
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function readJsonFile<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, 'utf8')) as T
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${i === 0 ? value.toFixed(0) : value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}
