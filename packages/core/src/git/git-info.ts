/**
 * Read-only Git introspection used by the project scanner. Every call goes through the injected
 * `Exec` with constant argument arrays; nothing here ever mutates a repository.
 */
import path from 'node:path'
import type { GitRemoteInfo, GitWorktreeInfo, ProjectGitInfo } from '@devmig/model'
import { noopLogger, realPath, type Exec, type ExecResult, type Logger } from '@devmig/shared'

const GIT_TIMEOUT_MS = 15_000
const ZERO_SHA = /^0{40}$|^0{64}$/

export interface ParsedWorktree {
  path: string
  head: string | null
  /** Branch name without refs/heads/, or null when detached / bare. */
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason?: string
  prunable: boolean
  prunableReason?: string
}

/**
 * Parses `git worktree list --porcelain`. Entries are blank-line separated blocks of
 * `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`, `detached`, `bare`, `locked [reason]`,
 * `prunable [reason]`. The first entry is the primary worktree.
 */
export function parseWorktreeListPorcelain(text: string): ParsedWorktree[] {
  const result: ParsedWorktree[] = []
  let current: ParsedWorktree | undefined
  const flush = (): void => {
    if (current) result.push(current)
    current = undefined
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
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
        current.head = ZERO_SHA.test(value) ? null : value
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
        if (value) current.lockedReason = value
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
  return result
}

const URL_WITH_USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/@]*)@(.*)$/

/**
 * Removes credentials from a remote URL before it is stored anywhere (manifest, scan, logs).
 * http(s): the whole userinfo goes (tokens travel there). Other schemes: only a `:password` part goes;
 * `ssh://git@host` keeps its user because it is part of the address, not a secret.
 */
export function stripRemoteUrlCredentials(url: string): string {
  const m = URL_WITH_USERINFO.exec(url)
  if (!m) return url
  const [, scheme, userinfo, rest] = m
  if (!scheme || userinfo === undefined || rest === undefined) return url
  if (/^https?$/i.test(scheme)) return `${scheme}://${rest}`
  const colon = userinfo.indexOf(':')
  if (colon === -1) return url
  const user = userinfo.slice(0, colon)
  return user ? `${scheme}://${user}@${rest}` : `${scheme}://${rest}`
}

/** Parses `git remote -v` output, merging the fetch/push lines of each remote. */
export function parseRemotes(text: string): GitRemoteInfo[] {
  const byName = new Map<string, { fetchUrl?: string; pushUrl?: string }>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line)
    if (!match) continue
    const [, name, url, kind] = match
    if (!name || !url || !kind) continue
    const entry = byName.get(name) ?? {}
    if (kind === 'fetch') entry.fetchUrl = stripRemoteUrlCredentials(url)
    else entry.pushUrl = stripRemoteUrlCredentials(url)
    byName.set(name, entry)
  }
  const remotes: GitRemoteInfo[] = []
  for (const [name, entry] of byName) {
    const fetchUrl = entry.fetchUrl ?? entry.pushUrl
    if (!fetchUrl) continue
    const remote: GitRemoteInfo = { name, fetchUrl }
    if (entry.pushUrl && entry.pushUrl !== fetchUrl) remote.pushUrl = entry.pushUrl
    remotes.push(remote)
  }
  return remotes
}

/**
 * Relative path from the primary worktree when the worktree is a child of it or a sibling directory;
 * undefined otherwise (the restore planner then falls back to `<newParent>/<basename>`).
 */
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

async function run(
  exec: Exec,
  dir: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ExecResult | undefined> {
  try {
    const result = await exec('git', args, {
      cwd: dir,
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
      reject: false,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    return result.failed ? undefined : result
  } catch {
    return undefined
  }
}

export interface ReadGitInfoOptions {
  signal?: AbortSignal
  logger?: Logger
}

/**
 * Describes the repository containing `dir`, or undefined when the directory is not inside a Git
 * working tree or git is unavailable. Never throws.
 */
export async function readProjectGitInfo(
  dir: string,
  exec: Exec,
  options: ReadGitInfoOptions = {},
): Promise<ProjectGitInfo | undefined> {
  const logger = options.logger ?? noopLogger
  const signal = options.signal
  if (dir.startsWith('-')) return undefined
  try {
    const top = await run(exec, dir, ['rev-parse', '--show-toplevel'], signal)
    if (!top || !top.stdout.trim()) {
      logger.debug('Not a git working tree (or git unavailable)', { dir })
      return undefined
    }
    const root = await realPath(top.stdout.trim())

    const [commonDirResult, headResult, branchResult, remotesResult, worktreesResult] =
      await Promise.all([
        run(exec, dir, ['rev-parse', '--git-common-dir'], signal),
        run(exec, dir, ['rev-parse', '--verify', '-q', 'HEAD'], signal),
        run(exec, dir, ['symbolic-ref', '--short', '-q', 'HEAD'], signal),
        run(exec, dir, ['remote', '-v'], signal),
        run(exec, dir, ['worktree', 'list', '--porcelain'], signal),
      ])

    const commonDir = commonDirResult?.stdout.trim()
      ? await realPath(path.resolve(dir, commonDirResult.stdout.trim()))
      : undefined
    const head = headResult?.stdout.trim() || null
    const branch = branchResult?.stdout.trim() || null
    const detached = head !== null && branch === null
    const remotes = remotesResult ? parseRemotes(remotesResult.stdout) : []

    const parsed = worktreesResult ? parseWorktreeListPorcelain(worktreesResult.stdout) : []
    const nonBare = parsed.filter((w) => !w.bare)
    const primaryParsed = nonBare[0]
    const primaryPath = primaryParsed ? await realPath(primaryParsed.path) : root
    const worktrees: GitWorktreeInfo[] = []
    for (const w of nonBare) {
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
  } catch (err) {
    logger.warn('Reading git information failed; treating directory as non-git', {
      dir,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
