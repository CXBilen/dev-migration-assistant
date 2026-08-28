/**
 * Deterministic search-path resolution for a GUI-launched app (ADR-0010). A Finder-launched app
 * inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), so developer tools in ~/.local/bin or
 * /opt/homebrew/bin are invisible. We never spawn a login shell (it would run the user's rc files
 * and reintroduce a shell string); instead we add the well-known locations that exist on disk.
 */
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { InstallMethod } from '@devmig/model'

export type { InstallMethod }

export interface SearchPathIo {
  isDirectory(p: string): boolean
  isExecutableFile(p: string): boolean
  /** File content, or null when the file is missing or unreadable. */
  readTextFile(p: string): string | null
  /** Entry names of a directory, or [] when it is missing. */
  listDirectory(p: string): string[]
  /** Resolved symlinks, or `p` itself when resolution fails. */
  realPath(p: string): string
}

export const nodeSearchPathIo: SearchPathIo = {
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  isExecutableFile: (p) => {
    try {
      if (!statSync(p).isFile()) return false
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  readTextFile: (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  listDirectory: (p) => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  },
  realPath: (p) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  },
}

export const LAUNCHD_DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

export function splitSearchPath(value: string | undefined): string[] {
  if (!value) return []
  return value.split(path.delimiter).filter((s) => s.length > 0)
}

export function joinSearchPath(dirs: readonly string[]): string {
  return dirs.join(path.delimiter)
}

function linesOf(text: string | null): string[] {
  if (!text) return []
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

/** What macOS `path_helper` reads: /etc/paths then every file in /etc/paths.d (sorted). */
function systemPathFiles(io: SearchPathIo): string[] {
  const out = linesOf(io.readTextFile('/etc/paths'))
  for (const name of [...io.listDirectory('/etc/paths.d')].sort()) {
    out.push(...linesOf(io.readTextFile(path.join('/etc/paths.d', name))))
  }
  return out
}

const VERSION_DIR = /^v?(\d+)\.(\d+)\.(\d+)$/

function compareVersions(a: string, b: string): number {
  const ma = VERSION_DIR.exec(a)
  const mb = VERSION_DIR.exec(b)
  if (!ma || !mb) return a.localeCompare(b)
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(ma[i]) - Number(mb[i])
    if (d !== 0) return d
  }
  return 0
}

/** `~/.nvm/versions/node/<v>/bin` for the default alias (major match) or the highest version. */
function nvmDefaultBin(homeDir: string, io: SearchPathIo): string | null {
  const versionsDir = path.join(homeDir, '.nvm', 'versions', 'node')
  const versions = io
    .listDirectory(versionsDir)
    .filter((n) => VERSION_DIR.test(n))
    .sort(compareVersions)
  if (versions.length === 0) return null
  const alias = linesOf(io.readTextFile(path.join(homeDir, '.nvm', 'alias', 'default')))[0]
  let pick = versions[versions.length - 1]!
  if (alias) {
    const wanted = alias.replace(/^v/, '')
    const matching = versions.filter(
      (v) => v.replace(/^v/, '').startsWith(`${wanted}.`) || v.replace(/^v/, '') === wanted,
    )
    if (matching.length > 0) pick = matching[matching.length - 1]!
  }
  return path.join(versionsDir, pick, 'bin')
}

/** Well-known per-user and package-manager locations (only those that exist are returned). */
export function userSearchDirs(homeDir: string, io: SearchPathIo): string[] {
  const candidates = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.claude', 'local'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.volta', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    path.join(homeDir, '.yarn', 'bin'),
    path.join(homeDir, '.fnm', 'aliases', 'default', 'bin'),
    path.join(homeDir, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    path.join(homeDir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(homeDir, '.local', 'share', 'mise', 'shims'),
    path.join(homeDir, '.asdf', 'shims'),
  ]
  const nvm = nvmDefaultBin(homeDir, io)
  if (nvm) candidates.push(nvm)
  return candidates.filter((d) => io.isDirectory(d))
}

export interface ResolveSearchPathInput {
  homeDir: string
  /** The PATH the process was started with (may be launchd's minimal one). */
  basePath?: string
  io?: SearchPathIo
}

/** Ordered, de-duplicated list of existing directories: base PATH, /etc/paths(.d), user dirs. */
export function resolveSearchPath(input: ResolveSearchPathInput): string[] {
  const io = input.io ?? nodeSearchPathIo
  const seen = new Set<string>()
  const out: string[] = []
  const add = (dir: string): void => {
    if (seen.has(dir) || !io.isDirectory(dir)) return
    seen.add(dir)
    out.push(dir)
  }
  for (const d of splitSearchPath(input.basePath)) add(d)
  for (const d of systemPathFiles(io)) add(d)
  for (const d of userSearchDirs(input.homeDir, io)) add(d)
  return out
}

/** First executable named `file` on `searchPath`; an absolute path is accepted as-is when executable. */
export function resolveExecutable(
  file: string,
  searchPath: string | undefined,
  io: SearchPathIo = nodeSearchPathIo,
): string | null {
  if (file.length === 0 || file.includes('\0')) return null
  if (path.isAbsolute(file)) return io.isExecutableFile(file) ? file : null
  if (file.includes('/') || file.includes('\\')) return null
  for (const dir of splitSearchPath(searchPath)) {
    const candidate = path.join(dir, file)
    if (io.isExecutableFile(candidate)) return candidate
  }
  return null
}

/** Classifies where a binary came from, from its resolved and real paths. Informational only. */
export function installMethodFor(
  resolvedPath: string,
  realPath: string,
  homeDir: string,
): InstallMethod {
  const real = realPath || resolvedPath
  const inHome = (p: string): boolean => p === homeDir || p.startsWith(`${homeDir}/`)
  if (real.includes('/.local/share/claude/versions/')) return 'native'
  if (
    real.startsWith('/opt/homebrew/') ||
    real.startsWith('/usr/local/Cellar/') ||
    real.startsWith('/usr/local/Homebrew/') ||
    real.startsWith('/home/linuxbrew/')
  )
    return 'homebrew'
  if (real.includes('/lib/node_modules/corepack/')) return 'corepack'
  if (real.includes('/lib/node_modules/')) return 'npm-global'
  if (/\/(\.nvm|\.volta|\.asdf|mise|fnm)\//.test(real)) return 'version-manager'
  if (/^\/(usr\/bin|bin|usr\/sbin|sbin|usr\/libexec)\//.test(real)) return 'system'
  if (inHome(resolvedPath) || inHome(real)) return 'manual'
  return 'unknown'
}
