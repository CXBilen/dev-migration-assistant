/**
 * Small typed wrapper over the injected `Exec` for git plumbing, plus locale-independent parsers for
 * git's porcelain formats and argument validation helpers.
 *
 * Rules enforced here:
 * - every subprocess is `git` with an ARGUMENT ARRAY (no shell),
 * - every externally sourced string (branch, sha, path, URL, remote name) is validated before it is
 *   placed in argv and never starts with '-',
 * - read-only invocations disable optional locks so the source repository is never touched.
 */
import path from 'node:path'
import type { GitRemoteInfo, GitWorktreeInfo, ProjectGitInfo } from '@devmig/model'
import {
  MigrationError,
  realPath,
  type Exec,
  type ExecOptions,
  type ExecResult,
} from '@devmig/shared'

export const GIT_MIN_SUPPORTED = { major: 2, minor: 20 } as const
const DEFAULT_TIMEOUT_MS = 120_000
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ZERO_SHA_RE = /^0+$/
const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const BRANCH_FORBIDDEN_CHARS = /[\s~^:?*[\\]/

// ---------------------------------------------------------------------------------------------
// argument validation
// ---------------------------------------------------------------------------------------------

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Validates a string that came from outside (backup payload, git output, user selection) before it is
 * placed in an argv array: non-empty, no control characters, never starting with '-'.
 */
export function assertSafeArg(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MigrationError('INVALID_INPUT', `${label} must be a non-empty string`)
  }
  if (hasControlCharacters(value)) {
    throw new MigrationError('INVALID_INPUT', `${label} contains control characters`, {
      details: { label },
    })
  }
  if (value.startsWith('-')) {
    throw new MigrationError('INVALID_INPUT', `${label} must not start with '-': ${value}`, {
      details: { label, value },
    })
  }
  return value
}

/** Local mirror of `git check-ref-format --branch` (run BEFORE git sees the string). */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.startsWith('-')) return false
  if (hasControlCharacters(name)) return false
  if (name === 'HEAD') return false
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false
  if (name.includes('//') || name.includes('..') || name.includes('@{')) return false
  if (name === '@') return false
  if (BRANCH_FORBIDDEN_CHARS.test(name)) return false
  return !name
    .split('/')
    .some(
      (component) => component === '' || component.startsWith('.') || component.endsWith('.lock'),
    )
}

export function assertSafeBranchName(name: string): string {
  if (!isValidBranchName(name)) {
    throw new MigrationError('GIT_INVALID_REF', `Invalid branch name: ${String(name)}`, {
      details: { name },
    })
  }
  return name
}

export function isSha(value: string): boolean {
  return typeof value === 'string' && SHA_RE.test(value)
}

export function assertSha(value: string, label = 'commit id'): string {
  if (!isSha(value)) {
    throw new MigrationError('GIT_INVALID_REF', `${label} is not a valid commit id`, {
      details: { label },
    })
  }
  return value
}

export function isValidRemoteName(name: string): boolean {
  return typeof name === 'string' && REMOTE_NAME_RE.test(name) && !name.includes('..')
}

export function assertSafeRemoteName(name: string): string {
  if (!isValidRemoteName(name)) {
    throw new MigrationError('INVALID_INPUT', `Invalid remote name: ${String(name)}`)
  }
  return name
}

/** Remote URLs are opaque, but must be argv-safe and must not use the exec-capable ext::/fd:: transports. */
export function isSafeRemoteUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false
  if (hasControlCharacters(url) || url.startsWith('-')) return false
  const lower = url.toLowerCase()
  return !lower.startsWith('ext::') && !lower.startsWith('fd::')
}

/** A full ref name such as refs/heads/main used as a config value (branch.<b>.merge). */
export function isSafeFullRef(ref: string): boolean {
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.length > 1024) return false
  if (hasControlCharacters(ref) || BRANCH_FORBIDDEN_CHARS.test(ref)) return false
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.'))
    return false
  return !ref.split('/').some((c) => c === '' || c.endsWith('.lock'))
}

// ---------------------------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------------------------

export interface GitVersion {
  major: number
  minor: number
  patch: number
  raw: string
}

export function parseGitVersion(text: string): GitVersion | undefined {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!m) return undefined
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] !== undefined ? Number(m[3]) : 0,
    raw: text.trim().split(/\r?\n/)[0] ?? text.trim(),
  }
}

export function isGitVersionAtLeast(v: GitVersion, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor)
}

// ---------------------------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------------------------

export interface GitRunOptions {
  cwd: string
  reject?: boolean
  timeoutMs?: number
  binary?: boolean
  maxBuffer?: number
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

export interface GitClient {
  /** Runs `git <args>` in `cwd`. Args must already be validated; options are constant strings. */
  run(args: readonly string[], options: GitRunOptions): Promise<ExecResult>
  readonly env: Record<string, string | undefined>
}

export interface CreateGitClientOptions {
  env: Record<string, string | undefined>
  signal?: AbortSignal
  /** Disable optional index locks so read-only commands never write into the repository (default true). */
  readOnly?: boolean
}

/** Environment variables that would redirect git away from `cwd`; they are never inherited. */
const UNSAFE_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const

export function gitEnvironment(
  base: Record<string, string | undefined>,
  readOnly: boolean,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  for (const key of UNSAFE_GIT_ENV) delete env[key]
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = ''
  env.SSH_ASKPASS = ''
  if (readOnly) env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

export function createGitClient(exec: Exec, options: CreateGitClientOptions): GitClient {
  const env = gitEnvironment(options.env, options.readOnly ?? true)
  return {
    env,
    run: (args, runOptions) => {
      for (const arg of args) {
        if (arg.includes('\0')) {
          throw new MigrationError('INVALID_INPUT', 'git argument contains a NUL byte')
        }
      }
      const execOptions: ExecOptions = {
        cwd: runOptions.cwd,
        env: { ...env, ...(runOptions.env ?? {}) },
        timeoutMs: runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: runOptions.signal ?? options.signal,
        reject: runOptions.reject,
        binary: runOptions.binary,
        maxBuffer: runOptions.maxBuffer,
      }
      return exec('git', args, execOptions)
    },
  }
}

export interface GitAvailability {
  available: boolean
  version?: GitVersion
  path?: string
  error?: string
}

/** `git --version` through the injected Exec. Never throws. */
export async function checkGitAvailable(
  exec: Exec,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<GitAvailability> {
  try {
    const result = await exec('git', ['--version'], {
      env: gitEnvironment(env, true),
      timeoutMs: 10_000,
      reject: false,
      signal,
    })
    if (result.failed) {
      return { available: false, error: result.stderr.trim() || `exit code ${result.exitCode}` }
    }
    const version = parseGitVersion(result.stdout)
    return version ? { available: true, version } : { available: true }
  } catch (err) {
    if (err instanceof MigrationError && err.code === 'CANCELLED') throw err
    return { available: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------------------------

export interface WorktreeListEntry {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockReason?: string
  prunable: boolean
  prunableReason?: string
}

/** Parses `git worktree list --porcelain`. The main worktree is the first entry. */
export function parseWorktreeList(text: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = []
  let current: WorktreeListEntry | null = null
  const flush = (): void => {
    if (current) entries.push(current)
    current = null
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '') {
      flush()
      continue
    }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      flush()
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      }
      continue
    }
    if (!current) continue
    switch (key) {
      case 'HEAD':
        current.head = ZERO_SHA_RE.test(value) ? null : value
        break
      case 'branch':
        current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
        break
      case 'detached':
        current.detached = true
        break
      case 'bare':
        current.bare = true
        break
      case 'locked':
        current.locked = true
        if (value) current.lockReason = value
        break
      case 'prunable':
        current.prunable = true
        if (value) current.prunableReason = value
        break
      default:
        break
    }
  }
  flush()
  return entries
}

export interface StatusChanged {
  kind: 'changed'
  xy: string
  submodule: string
  modeHead: string
  modeIndex: string
  modeWorktree: string
  hashHead: string
  hashIndex: string
  path: string
  staged: boolean
  unstaged: boolean
}
export interface StatusRenamed {
  kind: 'renamed'
  xy: string
  submodule: string
  modeHead: string
  modeIndex: string
  modeWorktree: string
  hashHead: string
  hashIndex: string
  score: string
  path: string
  originalPath: string
  staged: boolean
  unstaged: boolean
}
export interface StatusUnmerged {
  kind: 'unmerged'
  xy: string
  submodule: string
  modeStage1: string
  modeStage2: string
  modeStage3: string
  modeWorktree: string
  hashStage1: string
  hashStage2: string
  hashStage3: string
  path: string
}
export interface StatusUntracked {
  kind: 'untracked'
  path: string
}
export interface StatusIgnored {
  kind: 'ignored'
  path: string
}
export interface StatusHeader {
  kind: 'header'
  key: string
  value: string
}
export interface StatusUnknown {
  kind: 'unknown'
  line: string
}
export type StatusEntry =
  | StatusChanged
  | StatusRenamed
  | StatusUnmerged
  | StatusUntracked
  | StatusIgnored
  | StatusHeader
  | StatusUnknown

function field(parts: readonly string[], i: number): string {
  return parts[i] ?? ''
}

/**
 * Parses one `git status --porcelain=v2` record. `pathText` is everything after the fixed fields;
 * for rename records `originalPath` is supplied separately (-z mode) or split on TAB (line mode).
 */
function parseStatusRecord(record: string, originalPath?: string): StatusEntry {
  const tag = record.charAt(0)
  if (tag === '#') {
    const rest = record.slice(2)
    const space = rest.indexOf(' ')
    return {
      kind: 'header',
      key: space === -1 ? rest : rest.slice(0, space),
      value: space === -1 ? '' : rest.slice(space + 1),
    }
  }
  if (tag === '?') return { kind: 'untracked', path: record.slice(2) }
  if (tag === '!') return { kind: 'ignored', path: record.slice(2) }
  if (tag === '1') {
    const parts = record.split(' ')
    const xy = field(parts, 1)
    return {
      kind: 'changed',
      xy,
      submodule: field(parts, 2),
      modeHead: field(parts, 3),
      modeIndex: field(parts, 4),
      modeWorktree: field(parts, 5),
      hashHead: field(parts, 6),
      hashIndex: field(parts, 7),
      path: parts.slice(8).join(' '),
      staged: xy.charAt(0) !== '.',
      unstaged: xy.charAt(1) !== '.',
    }
  }
  if (tag === '2') {
    const parts = record.split(' ')
    const xy = field(parts, 1)
    const pathText = parts.slice(9).join(' ')
    let newPath = pathText
    let oldPath = originalPath ?? ''
    if (originalPath === undefined) {
      const tab = pathText.indexOf('\t')
      if (tab !== -1) {
        newPath = pathText.slice(0, tab)
        oldPath = pathText.slice(tab + 1)
      }
    }
    return {
      kind: 'renamed',
      xy,
      submodule: field(parts, 2),
      modeHead: field(parts, 3),
      modeIndex: field(parts, 4),
      modeWorktree: field(parts, 5),
      hashHead: field(parts, 6),
      hashIndex: field(parts, 7),
      score: field(parts, 8),
      path: newPath,
      originalPath: oldPath,
      staged: xy.charAt(0) !== '.',
      unstaged: xy.charAt(1) !== '.',
    }
  }
  if (tag === 'u') {
    const parts = record.split(' ')
    return {
      kind: 'unmerged',
      xy: field(parts, 1),
      submodule: field(parts, 2),
      modeStage1: field(parts, 3),
      modeStage2: field(parts, 4),
      modeStage3: field(parts, 5),
      modeWorktree: field(parts, 6),
      hashStage1: field(parts, 7),
      hashStage2: field(parts, 8),
      hashStage3: field(parts, 9),
      path: parts.slice(10).join(' '),
    }
  }
  return { kind: 'unknown', line: record }
}

/**
 * Parses NUL-terminated `git status --porcelain=v2 -z` output. In -z mode paths are never quoted and a
 * rename record is followed by a second NUL-terminated field holding the original path.
 */
export function parseStatusV2Z(text: string): StatusEntry[] {
  const out: StatusEntry[] = []
  const tokens = text.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? ''
    if (token === '') continue
    if (token.charAt(0) === '2') {
      const original = tokens[i + 1] ?? ''
      i += 1
      out.push(parseStatusRecord(token, original))
    } else {
      out.push(parseStatusRecord(token))
    }
  }
  return out
}

/** Parses newline-separated `git status --porcelain=v2` lines (paths may be C-quoted; they are unquoted). */
export function parseStatusV2Lines(lines: readonly string[]): StatusEntry[] {
  const out: StatusEntry[] = []
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '') continue
    const entry = parseStatusRecord(line)
    switch (entry.kind) {
      case 'changed':
      case 'unmerged':
      case 'untracked':
      case 'ignored':
        entry.path = unquoteCPath(entry.path)
        break
      case 'renamed':
        entry.path = unquoteCPath(entry.path)
        entry.originalPath = unquoteCPath(entry.originalPath)
        break
      default:
        break
    }
    out.push(entry)
  }
  return out
}

export function statusEntryPath(entry: StatusEntry): string | null {
  switch (entry.kind) {
    case 'changed':
    case 'renamed':
    case 'unmerged':
    case 'untracked':
    case 'ignored':
      return entry.path
    default:
      return null
  }
}

/** Splits raw output into non-empty lines. */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l !== '')
}

/** Splits NUL-separated output (`-z` mode). */
export function splitNul(text: string): string[] {
  return text.split('\0').filter((s) => s !== '')
}

const C_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  '\\': '\\',
  '"': '"',
}

/** Reverses git's C-style path quoting ("a\tb", "\303\244"); returns the input unchanged when not quoted. */
export function unquoteCPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  const inner = value.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner.charAt(i)
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = inner.charAt(i + 1)
    if (/[0-7]/.test(next)) {
      const octal = inner.slice(i + 1, i + 4)
      const digits = /^[0-7]{1,3}/.exec(octal)?.[0] ?? next
      bytes.push(parseInt(digits, 8) & 0xff)
      i += digits.length
      continue
    }
    const mapped = C_ESCAPES[next]
    if (mapped !== undefined) {
      bytes.push(...Buffer.from(mapped, 'utf8'))
      i += 1
      continue
    }
    bytes.push(...Buffer.from(next, 'utf8'))
    i += 1
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Quotes a path the way git does with core.quotepath=false: only control characters, DEL, '"' and '\'
 * force quoting. Used to predict `git status` lines for verification.
 */
export function quoteCPath(value: string): string {
  let needsQuote = false
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || value[i] === '"' || value[i] === '\\') {
      needsQuote = true
      break
    }
  }
  if (!needsQuote) return value
  let out = '"'
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    switch (ch) {
      case '\x07':
        out += '\\a'
        break
      case '\b':
        out += '\\b'
        break
      case '\t':
        out += '\\t'
        break
      case '\n':
        out += '\\n'
        break
      case '\v':
        out += '\\v'
        break
      case '\f':
        out += '\\f'
        break
      case '\r':
        out += '\\r'
        break
      case '\\':
        out += '\\\\'
        break
      case '"':
        out += '\\"'
        break
      default:
        if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`
        else out += ch
    }
  }
  return `${out}"`
}

/** Parses `git remote -v`, merging fetch/push lines. */
export function parseRemotes(text: string): GitRemoteInfo[] {
  const byName = new Map<string, { fetchUrl?: string; pushUrl?: string }>()
  const order: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^(\S+)\t(.+?)\s+\((fetch|push)\)$/.exec(line)
    if (!match) continue
    const [, name, url, kind] = match
    if (!name || !url || !kind) continue
    const entry = byName.get(name) ?? {}
    if (!byName.has(name)) order.push(name)
    if (kind === 'fetch') entry.fetchUrl = url
    else entry.pushUrl = url
    byName.set(name, entry)
  }
  const remotes: GitRemoteInfo[] = []
  for (const name of order) {
    const entry = byName.get(name)
    if (!entry) continue
    const fetchUrl = entry.fetchUrl ?? entry.pushUrl
    if (!fetchUrl) continue
    const remote: GitRemoteInfo = { name, fetchUrl }
    if (entry.pushUrl && entry.pushUrl !== fetchUrl) remote.pushUrl = entry.pushUrl
    remotes.push(remote)
  }
  return remotes
}

export interface ObjectCounts {
  looseObjects: number
  looseBytes: number
  packedObjects: number
  packBytes: number
  totalBytes: number
}

/** Parses `git count-objects -v` (sizes are reported in KiB). */
export function parseCountObjects(text: string): ObjectCounts {
  const values = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z-]+):\s*(\d+)$/.exec(line.trim())
    if (m && m[1] && m[2]) values.set(m[1], Number(m[2]))
  }
  const looseBytes = (values.get('size') ?? 0) * 1024
  const packBytes = (values.get('size-pack') ?? 0) * 1024
  return {
    looseObjects: values.get('count') ?? 0,
    looseBytes,
    packedObjects: values.get('in-pack') ?? 0,
    packBytes,
    totalBytes: looseBytes + packBytes,
  }
}

export interface UpstreamInfo {
  remote?: string
  merge?: string
}

/** Parses `git config --get-regexp '^branch\..*\.(remote|merge)$'` into branch -> upstream. */
export function parseUpstreams(text: string): Record<string, UpstreamInfo> {
  const out: Record<string, UpstreamInfo> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const space = line.indexOf(' ')
    if (space === -1) continue
    const key = line.slice(0, space)
    const value = line.slice(space + 1)
    const m = /^branch\.(.+)\.(remote|merge)$/.exec(key)
    if (!m || !m[1] || !m[2]) continue
    const branch = m[1]
    const entry = out[branch] ?? {}
    if (m[2] === 'remote') entry.remote = value
    else entry.merge = value
    out[branch] = entry
  }
  return out
}

/** Number of stash entries in `git stash list` output. */
export function countStashEntries(text: string): number {
  return splitLines(text).length
}

/** Path of a linked worktree relative to the primary when it is a child or sibling; undefined otherwise. */
export function relativeToPrimaryFor(
  primaryPath: string,
  worktreePath: string,
): string | undefined {
  if (primaryPath === worktreePath) return undefined
  const rel = path.relative(primaryPath, worktreePath)
  if (rel === '' || path.isAbsolute(rel)) return undefined
  const isChild = !rel.startsWith('..')
  const isSibling = path.dirname(worktreePath) === path.dirname(primaryPath)
  if (isChild || isSibling) return rel
  return undefined
}

// ---------------------------------------------------------------------------------------------
// higher-level read-only queries
// ---------------------------------------------------------------------------------------------

export async function readHead(
  git: GitClient,
  cwd: string,
): Promise<{ head: string | null; branch: string | null; detached: boolean }> {
  const headRes = await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd,
    reject: false,
  })
  const head = headRes.exitCode === 0 && isSha(headRes.stdout.trim()) ? headRes.stdout.trim() : null
  const branchRes = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    reject: false,
  })
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() || null : null
  return { head, branch, detached: head !== null && branch === null }
}

export async function listRemotes(git: GitClient, cwd: string): Promise<GitRemoteInfo[]> {
  const res = await git.run(['remote', '-v'], { cwd, reject: false })
  return res.failed ? [] : parseRemotes(res.stdout)
}

export async function listWorktrees(git: GitClient, cwd: string): Promise<WorktreeListEntry[]> {
  const res = await git.run(['worktree', 'list', '--porcelain'], { cwd, reject: false })
  return res.failed ? [] : parseWorktreeList(res.stdout)
}

export async function readUpstreams(
  git: GitClient,
  cwd: string,
): Promise<Record<string, UpstreamInfo>> {
  const res = await git.run(['config', '--get-regexp', '^branch\\..*\\.(remote|merge)$'], {
    cwd,
    reject: false,
  })
  // exit code 1 = no matches
  return res.exitCode === 0 ? parseUpstreams(res.stdout) : {}
}

export async function refExists(git: GitClient, cwd: string, fullRef: string): Promise<boolean> {
  if (!isSafeFullRef(fullRef)) return false
  const res = await git.run(['show-ref', '--verify', '--quiet', fullRef], { cwd, reject: false })
  return res.exitCode === 0
}

/** Validates a branch name locally and then with git itself. Rejects '-'-prefixed names before git runs. */
export async function checkRefFormat(git: GitClient, cwd: string, name: string): Promise<boolean> {
  if (!isValidBranchName(name)) return false
  const res = await git.run(['check-ref-format', '--branch', name], { cwd, reject: false })
  return res.exitCode === 0
}

/** Builds a ProjectGitInfo for a directory using only this module's plumbing (used by tests and diagnostics). */
export async function inspectRepository(
  dir: string,
  git: GitClient,
): Promise<ProjectGitInfo | undefined> {
  const top = await git.run(['rev-parse', '--show-toplevel'], { cwd: dir, reject: false })
  if (top.failed || !top.stdout.trim()) return undefined
  const root = await realPath(top.stdout.trim())
  const common = await git.run(['rev-parse', '--git-common-dir'], { cwd: dir, reject: false })
  const commonDir = common.failed
    ? undefined
    : await realPath(path.resolve(dir, common.stdout.trim()))
  const { head, branch, detached } = await readHead(git, dir)
  const remotes = await listRemotes(git, dir)
  const parsed = (await listWorktrees(git, dir)).filter((w) => !w.bare)
  const primaryParsed = parsed[0]
  const primaryPath = primaryParsed ? await realPath(primaryParsed.path) : root
  const worktrees: GitWorktreeInfo[] = []
  for (const w of parsed) {
    const wtPath = await realPath(w.path)
    const isPrimary = wtPath === primaryPath
    const info: GitWorktreeInfo = {
      path: wtPath,
      branch: w.branch,
      head: w.head,
      isPrimary,
      detached: w.detached,
      locked: w.locked,
      prunable: w.prunable,
    }
    if (!isPrimary) {
      const rel = relativeToPrimaryFor(primaryPath, wtPath)
      if (rel !== undefined) info.relativeToPrimary = rel
    }
    worktrees.push(info)
  }
  const info: ProjectGitInfo = {
    root,
    remotes,
    head,
    branch,
    detached,
    isLinkedWorktree: worktrees.length > 0 ? root !== primaryPath : false,
    worktrees,
  }
  if (commonDir) info.commonDir = commonDir
  return info
}
