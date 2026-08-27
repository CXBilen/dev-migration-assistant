import path from 'node:path'

const ZERO_SHA_RE = /^0+$/

export interface WorktreeListEntry {
  /** Absolute path exactly as git printed it. */
  path: string
  /** Commit sha, or null for an unborn branch (git prints all zeros). */
  head: string | null
  /** Branch name without refs/heads/, or null when detached/bare. */
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockReason?: string
  prunable: boolean
  prunableReason?: string
}

/** Parses `git worktree list --porcelain` (blank-line separated blocks). The main worktree is first. */
export function parseWorktreeListPorcelain(text: string): WorktreeListEntry[] {
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

export interface StatusV2Changed {
  kind: 'changed'
  /** Two-letter XY: X = index (staged) status, Y = worktree (unstaged) status, '.' = unmodified. */
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
export interface StatusV2Renamed {
  kind: 'renamed'
  xy: string
  submodule: string
  modeHead: string
  modeIndex: string
  modeWorktree: string
  hashHead: string
  hashIndex: string
  /** e.g. "R100" */
  score: string
  path: string
  originalPath: string
  staged: boolean
  unstaged: boolean
}
export interface StatusV2Unmerged {
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
export interface StatusV2Untracked {
  kind: 'untracked'
  path: string
}
export interface StatusV2Ignored {
  kind: 'ignored'
  path: string
}
export interface StatusV2Header {
  kind: 'header'
  key: string
  value: string
}
export interface StatusV2Unknown {
  kind: 'unknown'
  line: string
}
export type StatusV2Entry =
  | StatusV2Changed
  | StatusV2Renamed
  | StatusV2Unmerged
  | StatusV2Untracked
  | StatusV2Ignored
  | StatusV2Header
  | StatusV2Unknown

function field(parts: string[], i: number): string {
  return parts[i] ?? ''
}

/** Parses lines of `git status --porcelain=v2` (newline-terminated form, not -z). */
export function parseStatusV2(lines: readonly string[]): StatusV2Entry[] {
  const out: StatusV2Entry[] = []
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '') continue
    const tag = line.charAt(0)
    if (tag === '#') {
      const rest = line.slice(2)
      const space = rest.indexOf(' ')
      out.push({
        kind: 'header',
        key: space === -1 ? rest : rest.slice(0, space),
        value: space === -1 ? '' : rest.slice(space + 1),
      })
      continue
    }
    if (tag === '?') {
      out.push({ kind: 'untracked', path: line.slice(2) })
      continue
    }
    if (tag === '!') {
      out.push({ kind: 'ignored', path: line.slice(2) })
      continue
    }
    if (tag === '1') {
      const parts = line.split(' ')
      const xy = field(parts, 1)
      out.push({
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
      })
      continue
    }
    if (tag === '2') {
      const parts = line.split(' ')
      const xy = field(parts, 1)
      const pathPair = parts.slice(9).join(' ')
      const tab = pathPair.indexOf('\t')
      out.push({
        kind: 'renamed',
        xy,
        submodule: field(parts, 2),
        modeHead: field(parts, 3),
        modeIndex: field(parts, 4),
        modeWorktree: field(parts, 5),
        hashHead: field(parts, 6),
        hashIndex: field(parts, 7),
        score: field(parts, 8),
        path: tab === -1 ? pathPair : pathPair.slice(0, tab),
        originalPath: tab === -1 ? '' : pathPair.slice(tab + 1),
        staged: xy.charAt(0) !== '.',
        unstaged: xy.charAt(1) !== '.',
      })
      continue
    }
    if (tag === 'u') {
      const parts = line.split(' ')
      out.push({
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
      })
      continue
    }
    out.push({ kind: 'unknown', line })
  }
  return out
}

/** Repo-relative path named by a status entry (for header/unknown entries: null). */
export function statusEntryPath(entry: StatusV2Entry): string | null {
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

/** Splits raw porcelain output into non-empty lines. */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l !== '')
}

/** Splits NUL-separated output (e.g. `git ls-files -z`). */
export function splitNul(text: string): string[] {
  return text.split('\0').filter((s) => s !== '')
}

/** POSIX relative path from the primary worktree to a linked one ("../demo-onboarding"). */
export function relativeWorktreeShape(primaryPath: string, worktreePath: string): string {
  const rel = path.relative(primaryPath, worktreePath)
  return rel.split(path.sep).join('/')
}
