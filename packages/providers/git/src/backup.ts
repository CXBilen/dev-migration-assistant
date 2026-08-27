/**
 * createBackupArtifacts for the Git provider. Reads the source repository with plain git commands
 * (optional locks disabled — nothing in the source is ever modified) and writes the payload through
 * the provider's ScopedFs:
 *
 *   repository.json                 remotes, upstreams, HEAD, worktree shape, git version
 *   repo.bundle                     `git bundle create --all` (contains HEAD)
 *   worktrees/<n>/state.json        status lines, path lists, diff sizes
 *   worktrees/<n>/staged.diff       `git diff --cached --binary --full-index`
 *   worktrees/<n>/unstaged.diff     `git diff --binary --full-index`
 *   worktrees/<n>/untracked/…       untracked files (safe classification)
 *   worktrees/<n>/untracked-sensitive/…  only when the sensitive artifact was selected
 *   worktrees/<n>/ignored/<slug>    explicitly selected ignored files/directories
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BackupContext, ProviderBackupInput, ProviderBackupOutput } from '@devmig/core'
import type { ManifestArtifact, ScannedArtifact } from '@devmig/model'
import {
  MigrationError,
  formatBytes,
  isSafeArchivePath,
  pathExists,
  safeJoin,
  throwIfAborted,
} from '@devmig/shared'
import { parseSelection, plural, shortSha, worktreesOf, type WorktreeRef } from './common'
import {
  checkGitAvailable,
  countStashEntries,
  createGitClient,
  listRemotes,
  readHead,
  readUpstreams,
  splitLines,
  type GitClient,
} from './git'
import { classifyUntrackedFiles, readStatus, summarizeStatus, MAX_CONTENT_SNIFFS } from './scan'
import {
  BUNDLE_FILE,
  GIT_PROVIDER_ID,
  GIT_SCHEMA_VERSION,
  IGNORED_DIR,
  REPOSITORY_JSON,
  STAGED_DIFF,
  STATE_JSON,
  UNSTAGED_DIFF,
  UNTRACKED_DIR,
  UNTRACKED_SENSITIVE_DIR,
  WORKTREES_DIR,
  type RepositoryJson,
  type WorktreeRecord,
  type WorktreeStateJson,
} from './schema'

/** Diffs larger than this are still captured (streamed to disk) but produce a warning. */
export const DIFF_WARN_BYTES = 512 * 1024 * 1024
const BUNDLE_TIMEOUT_MS = 60 * 60_000
const DIFF_TIMEOUT_MS = 30 * 60_000
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Options that make `git diff` output applicable regardless of the user's diff configuration. */
export const DIFF_CONFIG_ARGS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.relative=false',
] as const
export const DIFF_OUTPUT_ARGS = [
  '--binary',
  '--full-index',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
] as const

interface DiffCapture {
  file: string
  bytes: number
  empty: boolean
}

async function captureDiff(
  git: GitClient,
  ctx: BackupContext,
  ref: WorktreeRef,
  stagingDir: string,
  kind: 'staged' | 'unstaged',
  warnings: string[],
): Promise<DiffCapture> {
  const fileName = kind === 'staged' ? STAGED_DIFF : UNSTAGED_DIFF
  const temp = path.join(ctx.tempDir, `worktree-${ref.index}-${fileName}`)
  const args = [
    ...DIFF_CONFIG_ARGS,
    'diff',
    ...(kind === 'staged' ? ['--cached'] : []),
    ...DIFF_OUTPUT_ARGS,
    `--output=${temp}`,
  ]
  await git.run(args, { cwd: ref.path, timeoutMs: DIFF_TIMEOUT_MS })
  const dest = path.join(stagingDir, fileName)
  let bytes = 0
  if (await pathExists(temp)) {
    bytes = (await fs.stat(temp)).size
    await ctx.fs.copyFile(temp, dest)
  } else {
    await ctx.fs.writeFileAtomic(dest, '')
  }
  if (bytes > DIFF_WARN_BYTES) {
    warnings.push(
      `The ${kind} diff of ${ref.path} is very large (${formatBytes(bytes)}); consider committing before migrating.`,
    )
  }
  return { file: fileName, bytes, empty: bytes === 0 }
}

interface CapturedWorktree {
  state: WorktreeStateJson
  bytes: number
  files: number
  sensitiveBytes: number
  sensitiveFiles: number
}

async function captureWorktree(
  ref: WorktreeRef,
  includeSensitive: boolean,
  git: GitClient,
  ctx: BackupContext,
  warnings: string[],
  budget: { remaining: number; exhausted: boolean },
): Promise<CapturedWorktree> {
  const stagingDir = path.join(ctx.stagingDir, WORKTREES_DIR, String(ref.index))
  await ctx.fs.mkdir(stagingDir, 0o700)
  const { head, branch, detached } = await readHead(git, ref.path)

  const linesRes = await git.run(
    ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--untracked-files=all'],
    { cwd: ref.path },
  )
  const statusLines = splitLines(linesRes.stdout).sort()
  const status = summarizeStatus(await readStatus(git, ref.path, { ignored: false }))

  throwIfAborted(ctx.signal)
  const stagedDiff = await captureDiff(git, ctx, ref, stagingDir, 'staged', warnings)
  const unstagedDiff = await captureDiff(git, ctx, ref, stagingDir, 'unstaged', warnings)

  throwIfAborted(ctx.signal)
  const untracked = await classifyUntrackedFiles(
    ref.path,
    status.untrackedPaths,
    ctx.signal,
    budget,
  )
  let bytes = stagedDiff.bytes + unstagedDiff.bytes
  let files = 0
  for (const file of untracked.safe) {
    throwIfAborted(ctx.signal)
    const dest = safeJoin(stagingDir, path.join(UNTRACKED_DIR, ...file.relPath.split('/')))
    await ctx.fs.copyFile(file.absPath, dest)
    bytes += file.sizeBytes
    files += 1
  }
  let sensitiveBytes = 0
  let sensitiveFiles = 0
  if (includeSensitive) {
    for (const file of untracked.sensitive) {
      throwIfAborted(ctx.signal)
      const dest = safeJoin(
        stagingDir,
        path.join(UNTRACKED_SENSITIVE_DIR, ...file.relPath.split('/')),
      )
      await ctx.fs.copyFile(file.absPath, dest)
      sensitiveBytes += file.sizeBytes
      sensitiveFiles += 1
    }
  }
  const excluded = [
    ...untracked.credential.map((f) => f.relPath),
    ...untracked.skipped.map((s) => s.relPath),
  ]
  if (untracked.credential.length > 0) {
    warnings.push(
      `${plural(untracked.credential.length, 'untracked credential file')} in ${ref.path} excluded: ${untracked.credential
        .map((f) => f.relPath)
        .slice(0, 5)
        .join(', ')}`,
    )
  }
  if (untracked.skipped.length > 0) {
    warnings.push(
      `${plural(untracked.skipped.length, 'untracked entry', 'untracked entries')} in ${ref.path} skipped (${[...new Set(untracked.skipped.map((s) => s.reason))].join(', ')}).`,
    )
  }
  const state: WorktreeStateJson = {
    schemaVersion: GIT_SCHEMA_VERSION,
    worktreeIndex: ref.index,
    path: ref.path,
    isPrimary: ref.isPrimary,
    branch,
    head,
    detached,
    ...(ref.relativeToPrimary !== undefined ? { relativeToPrimary: ref.relativeToPrimary } : {}),
    statusLines,
    stagedPaths: status.stagedPaths,
    unstagedPaths: status.unstagedPaths,
    conflictedPaths: status.conflictedPaths,
    untrackedPaths: untracked.safe.map((f) => f.relPath),
    sensitiveUntrackedPaths: untracked.sensitive.map((f) => f.relPath),
    sensitiveIncluded: includeSensitive,
    excludedUntrackedPaths: excluded,
    stagedDiff,
    unstagedDiff,
  }
  await ctx.fs.writeFileAtomic(
    path.join(stagingDir, STATE_JSON),
    JSON.stringify(state, null, 2),
    0o600,
  )
  return { state, bytes, files, sensitiveBytes, sensitiveFiles }
}

export async function createGitBackupArtifacts(
  input: ProviderBackupInput,
  ctx: BackupContext,
): Promise<ProviderBackupOutput> {
  const project = input.project
  if (!project?.git) {
    throw new MigrationError(
      'INVALID_INPUT',
      'The Git provider needs a project with repository information.',
      { details: { projectId: project?.id } },
    )
  }
  const availability = await checkGitAvailable(ctx.exec, ctx.env, ctx.signal)
  if (!availability.available) {
    throw new MigrationError('GIT_NOT_INSTALLED', 'git is not installed or not on PATH.', {
      hint: 'Install the Xcode Command Line Tools (xcode-select --install) or git via Homebrew.',
    })
  }
  const selection = parseSelection(input.artifacts)
  const warnings = [...selection.warnings]
  const git = createGitClient(ctx.exec, { env: ctx.env, signal: ctx.signal, readOnly: true })
  const refs = worktreesOf(project.git)
  const primary = refs[0]
  if (!primary) throw new MigrationError('PROVIDER_FAILED', 'No primary worktree found.')
  const byId = new Map<string, ScannedArtifact>(input.artifacts.map((a) => [a.id, a]))
  const repositoryJsonPayload = ctx.payloadPathFor(REPOSITORY_JSON)
  const artifacts: ManifestArtifact[] = []

  // ---- repository facts ----
  const primaryHead = await readHead(git, primary.path)
  const remotes = await listRemotes(git, primary.path)
  const upstreams = await readUpstreams(git, primary.path)
  const stashRes = await git.run(['stash', 'list'], { cwd: primary.path, reject: false })
  const stashCount = stashRes.failed ? 0 : countStashEntries(stashRes.stdout)
  const hasSubmodules = await pathExists(path.join(primary.path, '.gitmodules'))
  const emptyRepository = primaryHead.head === null

  // ---- bundle ----
  let bundle: RepositoryJson['bundle'] = { included: false, file: null, sizeBytes: 0 }
  if (selection.bundle && selection.bundleArtifactId) {
    if (emptyRepository) {
      warnings.push('The repository has no commits; no bundle was created.')
    } else {
      const item = { id: 'git:bundle', label: 'Repository bundle', status: 'running' as const }
      ctx.progress('Creating repository bundle…', undefined, item)
      const temp = path.join(ctx.tempDir, BUNDLE_FILE)
      const created = await git.run(['bundle', 'create', temp, '--all'], {
        cwd: primary.path,
        reject: false,
        timeoutMs: BUNDLE_TIMEOUT_MS,
      })
      if (created.failed) {
        throw new MigrationError('GIT_BUNDLE_FAILED', 'git bundle create failed.', {
          details: { stderr: created.stderr.slice(0, 2000), exitCode: created.exitCode },
        })
      }
      const verified = await git.run(['bundle', 'verify', temp], {
        cwd: primary.path,
        reject: false,
      })
      if (verified.failed) {
        throw new MigrationError('GIT_BUNDLE_FAILED', 'The created bundle failed verification.', {
          details: { stderr: verified.stderr.slice(0, 2000) },
        })
      }
      const dest = path.join(ctx.stagingDir, BUNDLE_FILE)
      await ctx.fs.copyFile(temp, dest)
      const sizeBytes = (await fs.stat(dest)).size
      bundle = { included: true, file: BUNDLE_FILE, sizeBytes }
      artifacts.push({
        id: selection.bundleArtifactId,
        providerId: GIT_PROVIDER_ID,
        kind: 'derived',
        label: 'Repository (all branches, tags)',
        payloadPath: ctx.payloadPathFor(BUNDLE_FILE),
        sizeBytes,
        fileCount: 1,
        sensitivity: 'safe',
        sourcePath: project.git.commonDir ?? primary.path,
        meta: { kind: 'bundle', primaryPath: primary.path, repositoryJson: repositoryJsonPayload },
      })
      ctx.progress(`✓ Repository bundle (${formatBytes(sizeBytes)})`, undefined, {
        ...item,
        status: 'done',
      })
    }
  }

  // ---- worktrees ----
  const budget = { remaining: MAX_CONTENT_SNIFFS, exhausted: false }
  const records: WorktreeRecord[] = []
  let changedFiles = 0
  let untrackedFiles = 0
  for (const ref of refs) {
    throwIfAborted(ctx.signal)
    const record: WorktreeRecord = {
      index: ref.index,
      path: ref.path,
      branch: ref.branch,
      head: ref.head,
      detached: ref.detached,
      isPrimary: ref.isPrimary,
      ...(ref.relativeToPrimary !== undefined ? { relativeToPrimary: ref.relativeToPrimary } : {}),
      locked: ref.locked,
      prunable: ref.prunable,
      captured: false,
    }
    const stateArtifactId = selection.worktreeStates.get(ref.index)
    if (!stateArtifactId) {
      records.push(record)
      continue
    }
    if (ref.prunable || !(await pathExists(ref.path))) {
      warnings.push(
        `Worktree ${ref.path} is missing on disk; its working tree state was not captured.`,
      )
      records.push(record)
      continue
    }
    const label = ref.isPrimary
      ? 'Working tree state'
      : `Worktree ${ref.relativeToPrimary ?? path.basename(ref.path)}`
    const item = { id: `git:worktree:${ref.index}`, label, status: 'running' as const }
    ctx.progress(`Capturing ${label.toLowerCase()}…`, undefined, item)
    const includeSensitive = selection.sensitive.has(ref.index)
    const captured = await captureWorktree(ref, includeSensitive, git, ctx, warnings, budget)
    record.head = captured.state.head
    record.branch = captured.state.branch
    record.detached = captured.state.detached
    record.captured = true
    records.push(record)
    const changed = new Set([
      ...captured.state.stagedPaths,
      ...captured.state.unstagedPaths,
      ...captured.state.conflictedPaths,
    ]).size
    changedFiles += changed
    untrackedFiles += captured.files
    const scanned = byId.get(stateArtifactId)
    artifacts.push({
      id: stateArtifactId,
      providerId: GIT_PROVIDER_ID,
      kind: 'file-set',
      label: scanned?.label ?? label,
      payloadPath: ctx.payloadPathFor(path.posix.join(WORKTREES_DIR, String(ref.index))),
      sizeBytes: captured.bytes,
      fileCount: captured.files + 3,
      sensitivity: 'safe',
      sourcePath: ref.path,
      meta: {
        kind: 'worktree-state',
        worktreeIndex: ref.index,
        path: ref.path,
        isPrimary: ref.isPrimary,
        branch: captured.state.branch,
        head: captured.state.head,
        detached: captured.state.detached,
        ...(ref.relativeToPrimary !== undefined
          ? { relativeToPrimary: ref.relativeToPrimary }
          : {}),
        repositoryJson: repositoryJsonPayload,
      },
    })
    const sensitiveArtifactId = selection.sensitive.get(ref.index)
    if (includeSensitive && sensitiveArtifactId) {
      const scannedSensitive = byId.get(sensitiveArtifactId)
      artifacts.push({
        id: sensitiveArtifactId,
        providerId: GIT_PROVIDER_ID,
        kind: 'file-set',
        label: scannedSensitive?.label ?? `${label}: sensitive untracked files`,
        payloadPath: ctx.payloadPathFor(
          path.posix.join(WORKTREES_DIR, String(ref.index), UNTRACKED_SENSITIVE_DIR),
        ),
        sizeBytes: captured.sensitiveBytes,
        fileCount: captured.sensitiveFiles,
        sensitivity: 'sensitive',
        sourcePath: ref.path,
        meta: {
          kind: 'untracked-sensitive',
          worktreeIndex: ref.index,
          path: ref.path,
          paths: captured.state.sensitiveUntrackedPaths,
          repositoryJson: repositoryJsonPayload,
        },
      })
      // The manifest requires every payloadPath to exist even when no sensitive file remained.
      const sensitiveDir = path.join(
        ctx.stagingDir,
        WORKTREES_DIR,
        String(ref.index),
        UNTRACKED_SENSITIVE_DIR,
      )
      if (!(await pathExists(sensitiveDir))) await ctx.fs.mkdir(sensitiveDir, 0o700)
    }
    ctx.progress(
      `✓ ${label}: ${plural(changed, 'changed file')}, ${plural(captured.files, 'untracked file')}`,
      undefined,
      { ...item, status: 'done' },
    )
  }

  // ---- explicitly selected ignored entries ----
  for (const ig of selection.ignored) {
    throwIfAborted(ctx.signal)
    const ref = refs.find((r) => r.index === ig.worktreeIndex)
    if (!ref || !isSafeArchivePath(ig.relPath) || !SLUG_RE.test(ig.slug)) {
      warnings.push(`Ignored entry ${ig.relPath} could not be captured (invalid selection).`)
      continue
    }
    const src = safeJoin(ref.path, ig.relPath)
    let stat
    try {
      stat = await fs.lstat(src)
    } catch {
      warnings.push(`Ignored entry ${ig.relPath} no longer exists and was not captured.`)
      continue
    }
    if (stat.isSymbolicLink()) {
      warnings.push(`Ignored entry ${ig.relPath} is a symbolic link and was not captured.`)
      continue
    }
    const relDest = path.posix.join(WORKTREES_DIR, String(ref.index), IGNORED_DIR, ig.slug)
    const dest = safeJoin(ctx.stagingDir, path.join(...relDest.split('/')))
    let sizeBytes: number
    let fileCount: number
    if (stat.isDirectory()) {
      const copied = await ctx.fs.copyDir(src, dest)
      sizeBytes = copied.bytes
      fileCount = copied.files
      if (copied.skippedSymlinks.length > 0) {
        warnings.push(
          `${plural(copied.skippedSymlinks.length, 'symbolic link')} inside ${ig.relPath} skipped.`,
        )
      }
    } else if (stat.isFile()) {
      await ctx.fs.copyFile(src, dest)
      sizeBytes = stat.size
      fileCount = 1
    } else {
      warnings.push(`Ignored entry ${ig.relPath} is not a regular file and was not captured.`)
      continue
    }
    const scanned = byId.get(ig.artifactId)
    artifacts.push({
      id: ig.artifactId,
      providerId: GIT_PROVIDER_ID,
      kind: stat.isDirectory() ? 'directory' : 'file',
      label: ig.label,
      payloadPath: ctx.payloadPathFor(relDest),
      sizeBytes,
      fileCount,
      sensitivity: scanned?.sensitivity ?? 'sensitive',
      sourcePath: src,
      meta: {
        kind: 'ignored',
        worktreeIndex: ref.index,
        path: ref.path,
        relPath: ig.relPath,
        isDirectory: stat.isDirectory(),
        slug: ig.slug,
        repositoryJson: repositoryJsonPayload,
      },
    })
  }

  // ---- repository.json ----
  const repository: RepositoryJson = {
    schemaVersion: GIT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    gitVersion: availability.version?.raw ?? null,
    primaryPath: primary.path,
    commonDir: project.git.commonDir ?? null,
    head: primaryHead.head,
    branch: primaryHead.branch,
    detached: primaryHead.detached,
    bundle,
    remotes,
    upstreams,
    worktrees: records,
    stashCount,
    hasSubmodules,
  }
  await ctx.fs.writeFileAtomic(
    path.join(ctx.stagingDir, REPOSITORY_JSON),
    JSON.stringify(repository, null, 2),
    0o600,
  )
  if (stashCount > 0)
    warnings.push(`${plural(stashCount, 'stash entry', 'stash entries')} not captured.`)
  if (hasSubmodules) warnings.push('Submodules are not captured.')
  if (budget.exhausted) {
    warnings.push(
      `More than ${MAX_CONTENT_SNIFFS} untracked files: the remaining ones were classified by name only.`,
    )
  }

  return {
    artifacts,
    schemaVersion: GIT_SCHEMA_VERSION,
    summary: {
      worktreeCount: refs.length - 1,
      branch: primaryHead.branch,
      head: shortSha(primaryHead.head),
      detached: primaryHead.detached,
      remoteCount: remotes.length,
      bundleBytes: bundle.sizeBytes,
      changedFiles,
      untrackedFiles,
      gitVersion: availability.version?.raw ?? null,
    },
    warnings,
  }
}
