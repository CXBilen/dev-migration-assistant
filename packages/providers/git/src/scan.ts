/**
 * Read-only discovery of a project's Git state: per-worktree status, untracked files (with secret
 * classification), ignored entries (junk vs. selectable), repository size, remotes, stashes, submodules.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { classifyFile, classifyPath, type ScanContext } from '@devmig/core'
import type {
  ProjectDescriptor,
  ProviderScanResult,
  ScannedArtifact,
  Sensitivity,
  SummaryItem,
} from '@devmig/model'
import {
  dirSize,
  formatBytes,
  isSafeArchivePath,
  pathExists,
  safeJoin,
  throwIfAborted,
  walkFiles,
} from '@devmig/shared'
import {
  bundleArtifactId,
  ignoredArtifactId,
  isJunkPath,
  junkArtifactId,
  pathDepth,
  plural,
  shortSha,
  slugForPath,
  untrackedSensitiveArtifactId,
  worktreeStateArtifactId,
  worktreesOf,
  type WorktreeRef,
} from './common'
import {
  checkGitAvailable,
  countStashEntries,
  createGitClient,
  listRemotes,
  parseCountObjects,
  parseStatusV2Z,
  readHead,
  type GitClient,
  type StatusEntry,
} from './git'
import { GIT_PROVIDER_ID } from './schema'

/** Content of at most this many untracked files is sniffed for secrets; the rest is classified by name. */
export const MAX_CONTENT_SNIFFS = 2_000
/** Non-junk ignored entries deeper than this are summarised, not offered individually. */
export const MAX_IGNORED_DEPTH = 2
/** At most this many ignored entries become selectable artifacts per worktree. */
export const MAX_IGNORED_ARTIFACTS = 50
/** Sizing an ignored directory stops after this many files. */
export const MAX_IGNORED_SIZE_ENTRIES = 20_000
const MAX_DIR_SAMPLE_FILES = 50

export interface UntrackedFile {
  relPath: string
  absPath: string
  sizeBytes: number
  sensitivity: Sensitivity
  reasons: string[]
}

export interface IgnoredEntry {
  relPath: string
  absPath: string
  isDirectory: boolean
  junk: boolean
  sizeBytes?: number
  files?: number
  sizeTruncated?: boolean
  sensitivity: Sensitivity
  reasons: string[]
  slug: string
}

export interface WorktreeStatusSummary {
  stagedPaths: string[]
  unstagedPaths: string[]
  conflictedPaths: string[]
  untrackedPaths: string[]
  ignoredPaths: string[]
}

export interface WorktreeScan {
  ref: WorktreeRef
  exists: boolean
  head: string | null
  branch: string | null
  detached: boolean
  status: WorktreeStatusSummary
  untracked: {
    safe: UntrackedFile[]
    sensitive: UntrackedFile[]
    credential: UntrackedFile[]
    skipped: { relPath: string; reason: string }[]
  }
  ignored: IgnoredEntry[]
  deeperIgnoredCount: number
  warnings: string[]
}

export function summarizeStatus(entries: readonly StatusEntry[]): WorktreeStatusSummary {
  const summary: WorktreeStatusSummary = {
    stagedPaths: [],
    unstagedPaths: [],
    conflictedPaths: [],
    untrackedPaths: [],
    ignoredPaths: [],
  }
  for (const entry of entries) {
    switch (entry.kind) {
      case 'changed':
      case 'renamed':
        if (entry.staged) summary.stagedPaths.push(entry.path)
        if (entry.unstaged) summary.unstagedPaths.push(entry.path)
        break
      case 'unmerged':
        summary.conflictedPaths.push(entry.path)
        break
      case 'untracked':
        summary.untrackedPaths.push(entry.path)
        break
      case 'ignored':
        summary.ignoredPaths.push(entry.path)
        break
      default:
        break
    }
  }
  return summary
}

/** `git status --porcelain=v2 --untracked-files=all [--ignored=matching] -z` parsed. */
export async function readStatus(
  git: GitClient,
  cwd: string,
  opts: { ignored: boolean },
): Promise<StatusEntry[]> {
  const args = ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--untracked-files=all']
  if (opts.ignored) args.push('--ignored=matching')
  args.push('-z')
  const res = await git.run(args, { cwd })
  return parseStatusV2Z(res.stdout)
}

interface ClassifyBudget {
  remaining: number
  exhausted: boolean
}

async function classifyUntracked(
  absPath: string,
  budget: ClassifyBudget,
  signal: AbortSignal,
): Promise<{ sensitivity: Sensitivity; reasons: string[] }> {
  if (budget.remaining > 0) {
    budget.remaining -= 1
    const c = await classifyFile(absPath, { signal })
    return { sensitivity: c.sensitivity, reasons: c.reasons }
  }
  budget.exhausted = true
  const c = classifyPath(absPath)
  return { sensitivity: c.sensitivity, reasons: c.reasons }
}

/** Classifies every untracked file of a worktree. Symlinks, nested repositories and unreadable entries are skipped. */
export async function classifyUntrackedFiles(
  worktreePath: string,
  relPaths: readonly string[],
  signal: AbortSignal,
  budget: ClassifyBudget = { remaining: MAX_CONTENT_SNIFFS, exhausted: false },
): Promise<WorktreeScan['untracked']> {
  const out: WorktreeScan['untracked'] = { safe: [], sensitive: [], credential: [], skipped: [] }
  for (const relPath of relPaths) {
    throwIfAborted(signal)
    if (!isSafeArchivePath(relPath)) {
      out.skipped.push({ relPath, reason: 'unsafe path' })
      continue
    }
    let absPath: string
    try {
      absPath = safeJoin(worktreePath, relPath)
    } catch {
      out.skipped.push({ relPath, reason: 'path escapes the worktree' })
      continue
    }
    let stat
    try {
      stat = await fs.lstat(absPath)
    } catch {
      out.skipped.push({ relPath, reason: 'unreadable' })
      continue
    }
    if (stat.isSymbolicLink()) {
      out.skipped.push({ relPath, reason: 'symbolic link' })
      continue
    }
    if (stat.isDirectory()) {
      out.skipped.push({ relPath, reason: 'nested repository or directory entry' })
      continue
    }
    if (!stat.isFile()) {
      out.skipped.push({ relPath, reason: 'special file' })
      continue
    }
    const { sensitivity, reasons } = await classifyUntracked(absPath, budget, signal)
    const file: UntrackedFile = { relPath, absPath, sizeBytes: stat.size, sensitivity, reasons }
    if (sensitivity === 'credential') out.credential.push(file)
    else if (sensitivity === 'sensitive') out.sensitive.push(file)
    else out.safe.push(file)
  }
  return out
}

async function sizeIgnoredEntry(
  absPath: string,
  isDirectory: boolean,
  signal: AbortSignal,
): Promise<{ bytes: number; files: number; truncated: boolean }> {
  if (!isDirectory) {
    const st = await fs.stat(absPath)
    return { bytes: st.size, files: 1, truncated: false }
  }
  try {
    const { bytes, files } = await dirSize(absPath, {
      signal,
      maxEntries: MAX_IGNORED_SIZE_ENTRIES,
    })
    return { bytes, files, truncated: false }
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err
    return { bytes: 0, files: MAX_IGNORED_SIZE_ENTRIES, truncated: true }
  }
}

async function classifyIgnoredEntry(
  absPath: string,
  relPath: string,
  isDirectory: boolean,
  signal: AbortSignal,
): Promise<{ sensitivity: Sensitivity; reasons: string[] }> {
  if (!isDirectory) {
    const c = await classifyFile(absPath, { signal })
    return { sensitivity: c.sensitivity, reasons: c.reasons }
  }
  const byName = classifyPath(relPath)
  let sensitivity: Sensitivity = byName.sensitivity
  const reasons = new Set(byName.reasons)
  let sampled = 0
  for await (const entry of walkFiles(absPath, { signal, maxEntries: MAX_DIR_SAMPLE_FILES })) {
    sampled += 1
    if (sampled > MAX_DIR_SAMPLE_FILES) break
    const c = await classifyFile(entry.absolutePath, { signal })
    if (c.sensitivity === 'credential') {
      sensitivity = 'credential'
    } else if (c.sensitivity === 'sensitive' && sensitivity === 'safe') {
      sensitivity = 'sensitive'
    }
    for (const r of c.reasons) reasons.add(`${entry.relativePath}: ${r}`)
  }
  return { sensitivity, reasons: [...reasons] }
}

/** Turns `!` status entries into junk rows (not sized) and selectable entries (sized + classified). */
export async function inspectIgnoredEntries(
  worktreePath: string,
  ignoredPaths: readonly string[],
  signal: AbortSignal,
): Promise<{ entries: IgnoredEntry[]; deeperCount: number; warnings: string[] }> {
  const entries: IgnoredEntry[] = []
  const warnings: string[] = []
  let deeperCount = 0
  let selectable = 0
  for (const relPath of ignoredPaths) {
    throwIfAborted(signal)
    const trimmed = relPath.replace(/\/+$/, '')
    const isDirectory = relPath.endsWith('/')
    if (!isSafeArchivePath(trimmed)) continue
    if (pathDepth(trimmed) > MAX_IGNORED_DEPTH) {
      deeperCount += 1
      continue
    }
    let absPath: string
    try {
      absPath = safeJoin(worktreePath, trimmed)
    } catch {
      continue
    }
    const slug = slugForPath(trimmed)
    if (isJunkPath(trimmed)) {
      entries.push({
        relPath: trimmed,
        absPath,
        isDirectory,
        junk: true,
        sensitivity: 'safe',
        reasons: [],
        slug,
      })
      continue
    }
    if (selectable >= MAX_IGNORED_ARTIFACTS) {
      deeperCount += 1
      continue
    }
    selectable += 1
    try {
      const size = await sizeIgnoredEntry(absPath, isDirectory, signal)
      const { sensitivity, reasons } = await classifyIgnoredEntry(
        absPath,
        trimmed,
        isDirectory,
        signal,
      )
      entries.push({
        relPath: trimmed,
        absPath,
        isDirectory,
        junk: false,
        sizeBytes: size.bytes,
        files: size.files,
        sizeTruncated: size.truncated,
        sensitivity,
        reasons,
        slug,
      })
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err
      warnings.push(`Ignored entry ${trimmed} could not be inspected and is not offered.`)
    }
  }
  return { entries, deeperCount, warnings }
}

export async function scanWorktree(
  ref: WorktreeRef,
  git: GitClient,
  signal: AbortSignal,
  budget: ClassifyBudget,
): Promise<WorktreeScan> {
  const warnings: string[] = []
  const empty: WorktreeScan = {
    ref,
    exists: false,
    head: ref.head,
    branch: ref.branch,
    detached: ref.detached,
    status: {
      stagedPaths: [],
      unstagedPaths: [],
      conflictedPaths: [],
      untrackedPaths: [],
      ignoredPaths: [],
    },
    untracked: { safe: [], sensitive: [], credential: [], skipped: [] },
    ignored: [],
    deeperIgnoredCount: 0,
    warnings,
  }
  if (!(await pathExists(ref.path))) {
    warnings.push(`Worktree ${ref.path} is missing on disk and will not be captured.`)
    return empty
  }
  const { head, branch, detached } = await readHead(git, ref.path)
  const entries = await readStatus(git, ref.path, { ignored: true })
  const status = summarizeStatus(entries)
  const untracked = await classifyUntrackedFiles(ref.path, status.untrackedPaths, signal, budget)
  const ignored = await inspectIgnoredEntries(ref.path, status.ignoredPaths, signal)
  warnings.push(...ignored.warnings)
  return {
    ref,
    exists: true,
    head,
    branch,
    detached,
    status,
    untracked,
    ignored: ignored.entries,
    deeperIgnoredCount: ignored.deeperCount,
    warnings,
  }
}

function worktreeLabel(scan: WorktreeScan): string {
  const where = scan.ref.isPrimary
    ? 'Working tree'
    : `Worktree ${scan.ref.relativeToPrimary ?? scan.ref.path}`
  const branch = scan.detached ? `detached @ ${shortSha(scan.head)}` : (scan.branch ?? 'no branch')
  return `${where} (${branch})`
}

function changeSummary(scan: WorktreeScan): string {
  const parts: string[] = []
  if (scan.status.stagedPaths.length) parts.push(`${scan.status.stagedPaths.length} staged`)
  if (scan.status.unstagedPaths.length) parts.push(`${scan.status.unstagedPaths.length} modified`)
  if (scan.status.conflictedPaths.length)
    parts.push(`${scan.status.conflictedPaths.length} conflicted`)
  const untracked = scan.untracked.safe.length + scan.untracked.sensitive.length
  if (untracked) parts.push(`${untracked} untracked`)
  return parts.length ? parts.join(', ') : 'clean'
}

/** Read-only scan of one project. Never throws for "not a repository"; that is reported in the result. */
export async function scanGitProject(
  project: ProjectDescriptor,
  ctx: ScanContext,
): Promise<ProviderScanResult> {
  const base = { providerId: GIT_PROVIDER_ID, projectId: project.id }
  if (!project.git) {
    return {
      ...base,
      detected: false,
      artifacts: [],
      summary: [{ label: '○ Not a Git repository', status: 'info' }],
      warnings: [],
      estimatedBytes: 0,
    }
  }
  const availability = await checkGitAvailable(ctx.exec, ctx.env, ctx.signal)
  if (!availability.available) {
    return {
      ...base,
      detected: true,
      artifacts: [],
      summary: [{ label: '! git is not installed', status: 'error' }],
      warnings: ['git is not installed; repository state cannot be captured.'],
      estimatedBytes: 0,
    }
  }
  const git = createGitClient(ctx.exec, { env: ctx.env, signal: ctx.signal, readOnly: true })
  const refs = worktreesOf(project.git)
  const primary = refs[0]
  if (!primary) {
    throw new Error('worktreesOf() returned no primary worktree')
  }
  const warnings: string[] = []
  const artifacts: ScannedArtifact[] = []
  const summary: SummaryItem[] = []
  let estimatedBytes = 0

  // ---- repository facts (from the primary worktree) ----
  const primaryHead = await readHead(git, primary.path)
  const objects = parseCountObjects(
    (await git.run(['count-objects', '-v'], { cwd: primary.path, reject: false })).stdout,
  )
  const remotes = await listRemotes(git, primary.path)
  const stashRes = await git.run(['stash', 'list'], { cwd: primary.path, reject: false })
  const stashCount = stashRes.failed ? 0 : countStashEntries(stashRes.stdout)
  const hasSubmodules = await pathExists(path.join(primary.path, '.gitmodules'))
  const emptyRepository = primaryHead.head === null

  ctx.progress(`Inspecting repository ${project.name}`)

  // ---- worktrees ----
  const budget: ClassifyBudget = { remaining: MAX_CONTENT_SNIFFS, exhausted: false }
  const scans: WorktreeScan[] = []
  for (const ref of refs) {
    throwIfAborted(ctx.signal)
    if (ref.prunable) {
      warnings.push(
        `Worktree ${ref.path} is prunable (its directory is gone) and will not be captured.`,
      )
      continue
    }
    ctx.progress(
      `Scanning ${ref.isPrimary ? 'working tree' : `worktree ${ref.relativeToPrimary ?? ref.path}`}`,
    )
    const scan = await scanWorktree(ref, git, ctx.signal, budget)
    warnings.push(...scan.warnings)
    if (scan.exists) scans.push(scan)
  }
  if (budget.exhausted) {
    warnings.push(
      `More than ${MAX_CONTENT_SNIFFS} untracked files: the remaining ones were classified by file name only.`,
    )
  }

  // ---- bundle ----
  if (emptyRepository) {
    warnings.push(
      'The repository has no commits yet; no bundle is created (working tree files are captured as untracked).',
    )
  } else {
    artifacts.push({
      id: bundleArtifactId(project.id),
      providerId: GIT_PROVIDER_ID,
      projectId: project.id,
      scope: 'project',
      kind: 'derived',
      label: 'Repository (all branches, tags)',
      description: `git bundle of every ref of ${project.name}; ${plural(remotes.length, 'remote')} recorded`,
      sourcePath: project.git.commonDir ?? primary.path,
      sizeBytes: objects.totalBytes,
      sensitivity: 'safe',
      includedByDefault: true,
      selectable: true,
      reasons: [],
      meta: { kind: 'bundle', primaryPath: primary.path },
    })
    estimatedBytes += objects.totalBytes
  }

  // ---- per worktree artifacts ----
  let modifiedTotal = 0
  let untrackedTotal = 0
  let sensitiveTotal = 0
  const junkNames = new Set<string>()
  for (const scan of scans) {
    const ref = scan.ref
    const changed = new Set([
      ...scan.status.stagedPaths,
      ...scan.status.unstagedPaths,
      ...scan.status.conflictedPaths,
    ])
    modifiedTotal += changed.size
    const safeUntrackedBytes = scan.untracked.safe.reduce((n, f) => n + f.sizeBytes, 0)
    untrackedTotal += scan.untracked.safe.length + scan.untracked.sensitive.length
    sensitiveTotal += scan.untracked.sensitive.length
    const count = changed.size + scan.untracked.safe.length
    const label = `${worktreeLabel(scan)}: ${changeSummary(scan)}`
    const stateReasons: string[] = []
    if (scan.untracked.credential.length) {
      stateReasons.push(
        `${plural(scan.untracked.credential.length, 'credential file')} excluded: ${scan.untracked.credential
          .map((f) => f.relPath)
          .slice(0, 5)
          .join(', ')}`,
      )
    }
    if (scan.untracked.skipped.length) {
      stateReasons.push(
        `${plural(scan.untracked.skipped.length, 'entry', 'entries')} skipped (${[...new Set(scan.untracked.skipped.map((s) => s.reason))].join(', ')})`,
      )
    }
    if (scan.status.conflictedPaths.length) {
      stateReasons.push(
        'Unresolved merge conflicts cannot be reproduced exactly; resolve them before backing up.',
      )
      warnings.push(
        `${worktreeLabel(scan)} has unresolved merge conflicts; conflict markers are captured as plain modifications.`,
      )
    }
    artifacts.push({
      id: worktreeStateArtifactId(project.id, ref.index),
      providerId: GIT_PROVIDER_ID,
      projectId: project.id,
      scope: 'project',
      kind: 'file-set',
      label,
      description: 'Staged and unstaged changes (as binary-safe diffs) plus untracked files',
      sourcePath: ref.path,
      sizeBytes: safeUntrackedBytes,
      count,
      sensitivity: 'safe',
      includedByDefault: true,
      selectable: true,
      reasons: stateReasons,
      meta: {
        kind: 'worktree-state',
        worktreeIndex: ref.index,
        path: ref.path,
        isPrimary: ref.isPrimary,
        branch: scan.branch,
        head: scan.head,
        detached: scan.detached,
        ...(ref.relativeToPrimary !== undefined
          ? { relativeToPrimary: ref.relativeToPrimary }
          : {}),
      },
    })
    estimatedBytes += safeUntrackedBytes

    if (scan.untracked.sensitive.length > 0) {
      const files = scan.untracked.sensitive
      artifacts.push({
        id: untrackedSensitiveArtifactId(project.id, ref.index),
        providerId: GIT_PROVIDER_ID,
        projectId: project.id,
        scope: 'project',
        kind: 'file-set',
        label: `${worktreeLabel(scan)}: ${plural(files.length, 'sensitive untracked file')}`,
        description: 'Untracked files that look like they contain secrets',
        sourcePath: ref.path,
        sizeBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
        count: files.length,
        sensitivity: 'sensitive',
        includedByDefault: false,
        selectable: true,
        reasons: files.map((f) => `${f.relPath}: ${f.reasons.join('; ') || 'looks sensitive'}`),
        meta: {
          kind: 'untracked-sensitive',
          worktreeIndex: ref.index,
          path: ref.path,
          paths: files.map((f) => f.relPath),
        },
      })
    }

    for (const entry of scan.ignored) {
      if (entry.junk) {
        junkNames.add(entry.relPath)
        artifacts.push({
          id: junkArtifactId(project.id, ref.index, entry.slug),
          providerId: GIT_PROVIDER_ID,
          projectId: project.id,
          scope: 'ephemeral',
          kind: entry.isDirectory ? 'directory' : 'file',
          label: `${entry.relPath}${entry.isDirectory ? '/' : ''} (ignored, not sized)`,
          description: 'Build output, dependencies or caches — reinstall on the destination',
          sourcePath: entry.absPath,
          sensitivity: 'safe',
          includedByDefault: false,
          selectable: false,
          reasons: ['Excluded automatically: regenerable build/dependency/cache content'],
          meta: { kind: 'junk', worktreeIndex: ref.index, relPath: entry.relPath },
        })
        continue
      }
      if (entry.sensitivity === 'credential') {
        artifacts.push({
          id: ignoredArtifactId(project.id, ref.index, entry.slug),
          providerId: GIT_PROVIDER_ID,
          projectId: project.id,
          scope: 'project',
          kind: entry.isDirectory ? 'directory' : 'file',
          label: `${entry.relPath}${entry.isDirectory ? '/' : ''} (credential, never migrated)`,
          sourcePath: entry.absPath,
          ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
          sensitivity: 'credential',
          includedByDefault: false,
          selectable: false,
          reasons: entry.reasons,
          meta: {
            kind: 'ignored',
            worktreeIndex: ref.index,
            path: ref.path,
            relPath: entry.relPath,
            isDirectory: entry.isDirectory,
            slug: entry.slug,
          },
        })
        continue
      }
      const sizeText =
        entry.sizeBytes === undefined
          ? 'not sized'
          : entry.sizeTruncated
            ? `> ${formatBytes(entry.sizeBytes)}`
            : formatBytes(entry.sizeBytes)
      artifacts.push({
        id: ignoredArtifactId(project.id, ref.index, entry.slug),
        providerId: GIT_PROVIDER_ID,
        projectId: project.id,
        scope: 'project',
        kind: entry.isDirectory ? 'directory' : 'file',
        label: `${entry.relPath}${entry.isDirectory ? '/' : ''} (ignored, ${sizeText})`,
        description: ref.isPrimary
          ? 'Ignored by .gitignore'
          : `Ignored by .gitignore in worktree ${ref.relativeToPrimary ?? ref.path}`,
        sourcePath: entry.absPath,
        ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
        ...(entry.files !== undefined ? { count: entry.files } : {}),
        sensitivity: entry.sensitivity,
        includedByDefault: false,
        selectable: true,
        reasons:
          entry.sensitivity === 'sensitive'
            ? entry.reasons
            : [
                'Ignored files are not part of the repository; include them explicitly if you need them.',
              ],
        meta: {
          kind: 'ignored',
          worktreeIndex: ref.index,
          path: ref.path,
          relPath: entry.relPath,
          isDirectory: entry.isDirectory,
          slug: entry.slug,
        },
      })
    }
    if (scan.deeperIgnoredCount > 0) {
      warnings.push(
        `${worktreeLabel(scan)}: ${plural(scan.deeperIgnoredCount, 'ignored entry', 'ignored entries')} deeper than ${MAX_IGNORED_DEPTH} levels (or beyond the first ${MAX_IGNORED_ARTIFACTS}) are not offered individually.`,
      )
    }
  }

  // ---- summary ----
  summary.push({
    label: '✓ repository',
    status: 'ok',
    detail: `${formatBytes(objects.totalBytes)} of objects, ${plural(remotes.length, 'remote')}${remotes[0] ? ` (${remotes[0].name})` : ''}`,
  })
  if (emptyRepository) {
    summary.push({ label: '! no commits yet', status: 'warn', detail: 'Bundle not offered' })
  } else if (primaryHead.detached) {
    summary.push({ label: `! detached HEAD @ ${shortSha(primaryHead.head)}`, status: 'warn' })
  } else {
    summary.push({
      label: `✓ ${primaryHead.branch ?? 'HEAD'} @ ${shortSha(primaryHead.head)}`,
      status: 'ok',
    })
  }
  if (refs.length > 1) {
    summary.push({
      label: `✓ ${plural(refs.length, 'worktree')}`,
      status: 'ok',
      detail: refs
        .filter((r) => !r.isPrimary)
        .map((r) => `${r.relativeToPrimary ?? r.path} (${r.branch ?? 'detached'})`)
        .join(', '),
    })
  }
  summary.push(
    modifiedTotal > 0
      ? { label: `! ${plural(modifiedTotal, 'modified file')}`, status: 'warn' }
      : { label: '✓ working tree clean', status: 'ok' },
  )
  if (untrackedTotal > 0) {
    summary.push({ label: `✓ ${plural(untrackedTotal, 'untracked file')}`, status: 'ok' })
  }
  if (sensitiveTotal > 0) {
    summary.push({
      label: `! ${plural(sensitiveTotal, 'sensitive untracked file')} excluded by default`,
      status: 'warn',
    })
  }
  if (junkNames.size > 0) {
    const names = [...junkNames]
    summary.push({
      label: `○ ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''} excluded`,
      status: 'info',
    })
  }
  if (stashCount > 0) {
    summary.push({
      label: `! ${plural(stashCount, 'stash', 'stashes')} not captured`,
      status: 'warn',
    })
    warnings.push(
      `${plural(stashCount, 'stash entry', 'stash entries')} are not captured; apply or export them before migrating.`,
    )
  }
  if (hasSubmodules) {
    summary.push({ label: '! submodules not captured', status: 'warn' })
    warnings.push('Submodules are not captured; run `git submodule update --init` after restoring.')
  }

  return {
    ...base,
    detected: true,
    artifacts,
    summary,
    warnings,
    estimatedBytes,
  }
}
