/**
 * Deterministic directory walk used by the packer and the checksum writer.
 * Entries are POSIX relative paths sorted by their UTF-8 byte sequence, so a directory always
 * precedes everything inside it. Symlinks and special files are never followed or included.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MigrationError, isSafeArchivePath, throwIfAborted } from '@devmig/shared'

export interface TreeEntry {
  /** POSIX relative path (no leading "./", no trailing "/"). */
  path: string
  kind: 'file' | 'dir'
  size: number
  mode: number
  mtime: Date
  absolute: string
}

export interface WalkTreeOptions {
  signal?: AbortSignal
  /** Abort with ARCHIVE_LIMIT_EXCEEDED beyond this many entries. */
  maxEntries?: number
  maxPathLength?: number
}

export interface WalkTreeResult {
  entries: TreeEntry[]
  /** Relative paths that were skipped because they are symlinks or special files. */
  skipped: string[]
}

/** Byte-wise comparison of the UTF-8 encoding (locale independent). */
export function comparePosixPaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export async function walkTree(root: string, opts: WalkTreeOptions = {}): Promise<WalkTreeResult> {
  const entries: TreeEntry[] = []
  const skipped: string[] = []
  const stack: string[] = ['']
  while (stack.length > 0) {
    throwIfAborted(opts.signal)
    const rel = stack.pop() as string
    const dir = rel ? path.join(root, rel) : root
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    for (const dirent of dirents) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
      if (!isSafeArchivePath(childRel) || dirent.name.includes('/')) {
        throw new MigrationError('INVALID_INPUT', `Unsafe path in source tree: ${childRel}`, {
          details: { path: childRel },
        })
      }
      if (
        opts.maxPathLength !== undefined &&
        Buffer.byteLength(childRel, 'utf8') > opts.maxPathLength
      ) {
        throw new MigrationError('ARCHIVE_LIMIT_EXCEEDED', `Path too long: ${childRel}`, {
          details: { path: childRel, max: opts.maxPathLength },
        })
      }
      const absolute = path.join(root, childRel)
      if (dirent.isSymbolicLink() || !(dirent.isDirectory() || dirent.isFile())) {
        skipped.push(childRel)
        continue
      }
      const stat = await fs.lstat(absolute)
      if (stat.isDirectory()) {
        entries.push({
          path: childRel,
          kind: 'dir',
          size: 0,
          mode: stat.mode,
          mtime: stat.mtime,
          absolute,
        })
        stack.push(childRel)
      } else if (stat.isFile()) {
        entries.push({
          path: childRel,
          kind: 'file',
          size: stat.size,
          mode: stat.mode,
          mtime: stat.mtime,
          absolute,
        })
      } else {
        skipped.push(childRel)
        continue
      }
      if (opts.maxEntries !== undefined && entries.length > opts.maxEntries) {
        throw new MigrationError('ARCHIVE_LIMIT_EXCEEDED', 'Too many entries in the source tree.', {
          details: { max: opts.maxEntries },
        })
      }
    }
  }
  entries.sort((a, b) => comparePosixPaths(a.path, b.path))
  skipped.sort(comparePosixPaths)
  return { entries, skipped }
}
