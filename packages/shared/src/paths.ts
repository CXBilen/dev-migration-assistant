import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Expands a leading ~ to the home directory. */
export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return p
}

/** Abbreviates the home directory prefix to ~ for display. */
export function displayPath(p: string, home: string = os.homedir()): string {
  if (p === home) return '~'
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length)
  return p
}

/**
 * Canonicalizes a path WITHOUT touching the filesystem:
 * ~ expansion, absolute resolution, NFC normalization, trailing-slash removal.
 */
export function canonicalizePath(p: string, home: string = os.homedir()): string {
  const expanded = expandHome(p.trim(), home)
  const resolved = path.resolve(expanded).normalize('NFC')
  if (resolved.length > 1 && resolved.endsWith(path.sep)) return resolved.slice(0, -1)
  return resolved
}

/** Canonicalizes and resolves symlinks. Falls back to the canonical path when it does not exist. */
export async function realPath(p: string, home: string = os.homedir()): Promise<string> {
  const canonical = canonicalizePath(p, home)
  try {
    return (await fs.realpath(canonical)).normalize('NFC')
  } catch {
    return canonical
  }
}

/** Case-sensitive comparison of canonicalized paths. Use realPath() first when symlinks matter. */
export function pathsEqual(a: string, b: string): boolean {
  return canonicalizePath(a) === canonicalizePath(b)
}

/** True when `child` is `parent` or located inside it (both canonicalized; no filesystem access). */
export function isPathWithin(parent: string, child: string): boolean {
  const p = canonicalizePath(parent)
  const c = canonicalizePath(child)
  if (p === c) return true
  const rel = path.relative(p, c)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Relative path from parent to child, or null if child is not within parent. */
export function relativeWithin(parent: string, child: string): string | null {
  if (!isPathWithin(parent, child)) return null
  return path.relative(canonicalizePath(parent), canonicalizePath(child))
}

/**
 * Joins `relative` onto `root` and guarantees the result stays within `root`.
 * Rejects absolute segments, `..` escapes, NUL bytes and empty segments.
 */
export function safeJoin(root: string, relative: string): string {
  if (relative.includes('\0')) throw new Error('Path contains NUL byte')
  if (path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative))
    throw new Error(`Absolute path not allowed: ${relative}`)
  const joined = path.resolve(root, relative)
  if (!isPathWithin(root, joined)) throw new Error(`Path escapes root: ${relative}`)
  return joined
}

/** Converts a relative path to POSIX separators for storage inside archives/manifests. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/** Returns true when a relative POSIX path is safe to place inside an archive: no '..', no absolute, no drive letters, no NUL. */
export function isSafeArchivePath(rel: string): boolean {
  if (!rel || rel.includes('\0')) return false
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel)) return false
  const segments = rel.split(/[\\/]/)
  return segments.every((s) => s !== '' && s !== '.' && s !== '..')
}
