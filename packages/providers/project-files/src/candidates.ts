/**
 * Discovery rules for local project artifacts (files Git does not carry: env files, tool-version pins,
 * package-manager config, compose overrides, local certificates). Pure rules + one bounded directory walk.
 */
import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import { isSafeArchivePath, throwIfAborted } from '@devmig/shared'

export type CandidateCategory =
  'env' | 'direnv' | 'package-manager' | 'version-pin' | 'compose' | 'certificate'

export interface CandidateFile {
  /** Path relative to the worktree root, POSIX separators. */
  relpath: string
  absPath: string
  sizeBytes: number
  /** Permission bits (mode & 0o777). */
  mode: number
  category: CandidateCategory
}

/** `.env.<suffix>` files that are templates, not local state. */
export const ENV_TEMPLATE_SUFFIXES: readonly string[] = [
  '.example',
  '.sample',
  '.template',
  '.dist',
]

/** Exact file names looked up at the root of every worktree. */
export const KNOWN_ROOT_FILES: Readonly<Record<string, CandidateCategory>> = {
  '.envrc': 'direnv',
  '.npmrc': 'package-manager',
  '.yarnrc': 'package-manager',
  '.yarnrc.yml': 'package-manager',
  '.nvmrc': 'version-pin',
  '.node-version': 'version-pin',
  '.tool-versions': 'version-pin',
  '.python-version': 'version-pin',
  '.ruby-version': 'version-pin',
  '.java-version': 'version-pin',
  '.sdkmanrc': 'version-pin',
  'docker-compose.override.yml': 'compose',
  'docker-compose.override.yaml': 'compose',
}

export const CERT_EXTENSIONS: readonly string[] = ['.pem', '.key', '.crt', '.p12', '.pfx']
export const CERT_DIRS: readonly string[] = ['certs', '.certs']
/** Directory levels searched below a cert directory (`certs/a.pem` = 1, `certs/dev/a.pem` = 2). */
export const CERT_MAX_DEPTH = 2

/** Files larger than this are listed but not selectable (project files are small by nature). */
export const MAX_PROJECT_FILE_BYTES = 16 * 1024 * 1024

/** `.env` and `.env.*` except templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`). */
export function isEnvFileName(name: string): boolean {
  if (name === '.env') return true
  if (!name.startsWith('.env.') || name.length <= '.env.'.length) return false
  const lower = name.toLowerCase()
  return !ENV_TEMPLATE_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

export function isCertFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return CERT_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length)
}

/** Category of a root-level file name, or null when it is not a known local artifact. */
export function categorizeRootFileName(name: string): CandidateCategory | null {
  if (isEnvFileName(name)) return 'env'
  const known = KNOWN_ROOT_FILES[name]
  if (known) return known
  if (isCertFileName(name)) return 'certificate'
  return null
}

/** Human label for a category (used in descriptions and summaries). */
export function categoryLabel(category: CandidateCategory): string {
  switch (category) {
    case 'env':
      return 'environment file'
    case 'direnv':
      return 'direnv file'
    case 'package-manager':
      return 'package manager config'
    case 'version-pin':
      return 'tool version pin'
    case 'compose':
      return 'compose override'
    case 'certificate':
      return 'local certificate/key'
  }
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** A relative path we are willing to store in a backup and to hand to git on stdin. */
export function isSafeRelpath(relpath: string): boolean {
  return isSafeArchivePath(relpath) && !hasControlCharacters(relpath) && !relpath.includes('\\')
}

export interface DiscoverOptions {
  signal?: AbortSignal
  /** Called for entries that were skipped for a reason worth surfacing (symlinks, unsafe names). */
  onSkip?: (relpath: string, reason: string) => void
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function toCandidate(
  root: string,
  relpath: string,
  category: CandidateCategory,
): Promise<CandidateFile | null> {
  const absPath = path.join(root, ...relpath.split('/'))
  try {
    const stat = await fs.lstat(absPath)
    if (!stat.isFile()) return null
    return { relpath, absPath, sizeBytes: stat.size, mode: stat.mode & 0o777, category }
  } catch {
    return null
  }
}

/**
 * Lists candidate local files under one worktree root: known names at the root, plus certificate
 * files under `certs/` or `.certs/` up to CERT_MAX_DEPTH levels. Symlinks are never followed.
 * Results are sorted by relative path so scans are deterministic.
 */
export async function discoverCandidates(
  root: string,
  opts: DiscoverOptions = {},
): Promise<CandidateFile[]> {
  const out: CandidateFile[] = []
  const skip = (relpath: string, reason: string): void => opts.onSkip?.(relpath, reason)

  const entries = await readDirSafe(root)
  for (const entry of entries) {
    throwIfAborted(opts.signal)
    const name = entry.name
    if (!isSafeRelpath(name)) {
      skip(name, 'unsafe file name')
      continue
    }
    if (entry.isSymbolicLink()) {
      if (categorizeRootFileName(name) !== null || CERT_DIRS.includes(name)) {
        skip(name, 'symbolic links are not migrated')
      }
      continue
    }
    if (entry.isDirectory()) {
      if (CERT_DIRS.includes(name)) await walkCertDir(root, name, 1, out, opts)
      continue
    }
    if (!entry.isFile()) continue
    const category = categorizeRootFileName(name)
    if (category === null) continue
    const candidate = await toCandidate(root, name, category)
    if (candidate) out.push(candidate)
  }
  out.sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0))
  return out
}

async function walkCertDir(
  root: string,
  rel: string,
  depth: number,
  out: CandidateFile[],
  opts: DiscoverOptions,
): Promise<void> {
  const entries = await readDirSafe(path.join(root, ...rel.split('/')))
  for (const entry of entries) {
    throwIfAborted(opts.signal)
    const childRel = `${rel}/${entry.name}`
    if (!isSafeRelpath(childRel)) {
      opts.onSkip?.(childRel, 'unsafe file name')
      continue
    }
    if (entry.isSymbolicLink()) {
      if (isCertFileName(entry.name)) opts.onSkip?.(childRel, 'symbolic links are not migrated')
      continue
    }
    if (entry.isDirectory()) {
      if (depth < CERT_MAX_DEPTH) await walkCertDir(root, childRel, depth + 1, out, opts)
      continue
    }
    if (!entry.isFile() || !isCertFileName(entry.name)) continue
    const candidate = await toCandidate(root, childRel, 'certificate')
    if (candidate) out.push(candidate)
  }
}
