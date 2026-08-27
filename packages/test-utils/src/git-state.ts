import type { Exec } from '@devmig/shared'
import { throwIfAborted } from '@devmig/shared'
import {
  parseStatusV2,
  parseWorktreeListPorcelain,
  relativeWorktreeShape,
  splitLines,
  splitNul,
  statusEntryPath,
  type WorktreeListEntry,
} from './git-parsers'

/** Everything a restore must reproduce, captured from a live checkout. Paths inside are repo-relative except `repoPath`/worktree paths. */
export interface GitStateSnapshot {
  /** Path the snapshot was taken in (primary or linked worktree). Never compared. */
  repoPath: string
  /** Commit sha of HEAD, or null in an unborn repo. */
  head: string | null
  /** Current branch, or null when detached. */
  branch: string | null
  detached: boolean
  /** Sorted lines of `git status --porcelain=v2 --untracked-files=all`. */
  statusV2: string[]
  /** `git diff --cached --binary --full-index` */
  stagedDiff: string
  /** `git diff --binary --full-index` */
  unstagedDiff: string
  /** Sorted `git ls-files --others --exclude-standard -z` entries. */
  untracked: string[]
  /** Parsed `git worktree list --porcelain` (main worktree first). */
  worktrees: WorktreeListEntry[]
}

export interface CaptureGitStateOptions {
  /** Extra environment for every git call (use gitTestEnv()/fixture.env for determinism). */
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

/** Captures the portable state of a checkout with plain git commands (read-only). */
export async function captureGitState(
  repoPath: string,
  exec: Exec,
  opts: CaptureGitStateOptions = {},
): Promise<GitStateSnapshot> {
  const run = (args: string[], extra: { reject?: boolean; binary?: boolean } = {}) =>
    exec('git', args, { cwd: repoPath, env: opts.env, signal: opts.signal, ...extra })

  throwIfAborted(opts.signal)
  const headRes = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], { reject: false })
  const head = headRes.exitCode === 0 ? headRes.stdout.trim() : null
  const branchRes = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { reject: false })
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : null
  const detached = head !== null && branch === null

  throwIfAborted(opts.signal)
  const status = await run(['status', '--porcelain=v2', '--untracked-files=all'])
  const statusV2 = splitLines(status.stdout).sort()
  const staged = await run(['diff', '--cached', '--binary', '--full-index'])
  const unstaged = await run(['diff', '--binary', '--full-index'])
  const others = await run(['ls-files', '--others', '--exclude-standard', '-z'])
  const untracked = splitNul(others.stdout).sort()
  const worktreeList = await run(['worktree', 'list', '--porcelain'])
  const worktrees = parseWorktreeListPorcelain(worktreeList.stdout)

  return {
    repoPath,
    head,
    branch,
    detached,
    statusV2,
    stagedDiff: staged.stdout,
    unstagedDiff: unstaged.stdout,
    untracked,
    worktrees,
  }
}

export interface CompareGitStateOptions {
  /**
   * Repo-relative paths (or directory prefixes) to leave out of the status/untracked/diff
   * comparison, e.g. files a restore intentionally does not recreate.
   */
  ignorePaths?: string[]
}

export interface GitStateComparison {
  equal: boolean
  differences: string[]
}

function isIgnored(relPath: string, ignorePaths: readonly string[]): boolean {
  return ignorePaths.some((p) => {
    const prefix = p.endsWith('/') ? p : `${p}/`
    return relPath === p || relPath.startsWith(prefix)
  })
}

function filterStatusLines(lines: readonly string[], ignorePaths: readonly string[]): string[] {
  if (ignorePaths.length === 0) return [...lines]
  return lines.filter((line) => {
    const entry = parseStatusV2([line])[0]
    if (!entry) return true
    const p = statusEntryPath(entry)
    return p === null || !isIgnored(p, ignorePaths)
  })
}

const DIFF_HEADER_RE = /^diff --git a\/(.*) b\/(.*)$/

/** Splits a unified diff into per-file blocks keyed by the b/ path. */
export function splitDiffByFile(diff: string): { path: string; text: string }[] {
  if (diff === '') return []
  const blocks: { path: string; text: string }[] = []
  let current: { path: string; text: string } | null = null
  for (const line of diff.split('\n')) {
    const m = DIFF_HEADER_RE.exec(line)
    if (m) {
      if (current) blocks.push(current)
      current = { path: m[2] ?? '', text: '' }
    }
    if (!current) {
      current = { path: '', text: '' }
    }
    current.text += `${line}\n`
  }
  if (current) blocks.push(current)
  return blocks.map((b) => ({ path: b.path, text: b.text.replace(/\n$/, '') }))
}

function filterDiff(diff: string, ignorePaths: readonly string[]): string {
  if (ignorePaths.length === 0) return diff
  return splitDiffByFile(diff)
    .filter((b) => !isIgnored(b.path, ignorePaths))
    .map((b) => b.text)
    .join('\n')
}

function diffArrays(
  label: string,
  a: readonly string[],
  b: readonly string[],
  out: string[],
): void {
  const setA = new Set(a)
  const setB = new Set(b)
  for (const x of a) if (!setB.has(x)) out.push(`${label}: only in first: ${x}`)
  for (const x of b) if (!setA.has(x)) out.push(`${label}: only in second: ${x}`)
}

function worktreeShape(entries: readonly WorktreeListEntry[]): string[] {
  const primary = entries[0]
  if (!primary) return []
  return entries
    .map((wt) => {
      const rel = wt === primary ? '.' : relativeWorktreeShape(primary.path, wt.path)
      const flags = [
        wt.detached ? 'detached' : '',
        wt.bare ? 'bare' : '',
        wt.locked ? 'locked' : '',
        wt.prunable ? 'prunable' : '',
      ]
        .filter(Boolean)
        .join(',')
      return `${rel} branch=${wt.branch ?? '(detached)'} head=${wt.head ?? '(unborn)'}${flags ? ` [${flags}]` : ''}`
    })
    .sort()
}

/**
 * Compares two snapshots ignoring absolute paths: worktrees are matched by their relative shape
 * to the primary worktree ("../demo-onboarding"), never by absolute location.
 */
export function compareGitState(
  a: GitStateSnapshot,
  b: GitStateSnapshot,
  opts: CompareGitStateOptions = {},
): GitStateComparison {
  const ignore = opts.ignorePaths ?? []
  const differences: string[] = []
  if (a.head !== b.head) differences.push(`head: ${a.head ?? 'null'} != ${b.head ?? 'null'}`)
  if (a.branch !== b.branch)
    differences.push(`branch: ${a.branch ?? 'null'} != ${b.branch ?? 'null'}`)
  if (a.detached !== b.detached) differences.push(`detached: ${a.detached} != ${b.detached}`)
  diffArrays(
    'statusV2',
    filterStatusLines(a.statusV2, ignore),
    filterStatusLines(b.statusV2, ignore),
    differences,
  )
  diffArrays(
    'untracked',
    a.untracked.filter((p) => !isIgnored(p, ignore)),
    b.untracked.filter((p) => !isIgnored(p, ignore)),
    differences,
  )
  const stagedA = filterDiff(a.stagedDiff, ignore)
  const stagedB = filterDiff(b.stagedDiff, ignore)
  if (stagedA !== stagedB) differences.push('stagedDiff differs')
  const unstagedA = filterDiff(a.unstagedDiff, ignore)
  const unstagedB = filterDiff(b.unstagedDiff, ignore)
  if (unstagedA !== unstagedB) differences.push('unstagedDiff differs')
  diffArrays('worktrees', worktreeShape(a.worktrees), worktreeShape(b.worktrees), differences)
  return { equal: differences.length === 0, differences }
}
