/**
 * planRestore for the Git provider: read-only against the extracted payload and the destination.
 * Produces preflight checks (git present/version, bundle readable, branch names valid), collisions
 * (destination / worktree paths that already exist), steps and the opaque PlanState for restore.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ProviderRestoreInput,
  ProviderRestorePlan,
  RestorePlanningContext,
} from '@devmig/core'
import type {
  Collision,
  CollisionPolicy,
  ManifestArtifact,
  PreflightCheck,
  RestoreStep,
} from '@devmig/model'
import {
  MigrationError,
  canonicalizePath,
  isSafeArchivePath,
  pathExists,
  safeJoin,
} from '@devmig/shared'
import { parseSelection, plural, shortSha } from './common'
import {
  GIT_MIN_SUPPORTED,
  checkGitAvailable,
  checkRefFormat,
  createGitClient,
  isGitVersionAtLeast,
  isSafeFullRef,
  isSafeRemoteUrl,
  isSha,
  isValidBranchName,
  isValidRemoteName,
} from './git'
import {
  GIT_PROVIDER_ID,
  PlanState,
  REPOSITORY_JSON,
  RepositoryJson,
  STATE_JSON,
  WORKTREES_DIR,
  WorktreeStateJson,
  type PlanIgnored,
  type PlanWorktree,
  type RemoteRecord,
} from './schema'

const COLLISION_POLICIES: CollisionPolicy[] = ['skip', 'backup-then-replace']

export function emptyRemap(): ProviderRestorePlan['remap'] {
  return { affected: [], safeRewriteCount: 0, warnings: [], unsupportedReferences: [] }
}

/** Reads and validates a JSON file from the payload (untrusted input). */
async function readJsonFile<T>(
  file: string,
  schema: {
    safeParse: (v: unknown) => {
      success: boolean
      data?: T
      error?: { issues: { path: PropertyKey[]; message: string }[] }
    }
  },
  what: string,
): Promise<T> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    throw new MigrationError('ARCHIVE_INVALID', `${what} is missing or not valid JSON.`, {
      details: { file },
      cause: err,
    })
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success || parsed.data === undefined) {
    throw new MigrationError('ARCHIVE_INVALID', `${what} has an unexpected shape.`, {
      details: {
        file,
        issues: parsed.error?.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    })
  }
  return parsed.data
}

export async function loadRepositoryJson(file: string): Promise<RepositoryJson> {
  return readJsonFile<RepositoryJson>(file, RepositoryJson, 'repository.json')
}

export async function loadWorktreeState(stateDir: string): Promise<WorktreeStateJson> {
  return readJsonFile<WorktreeStateJson>(
    path.join(stateDir, STATE_JSON),
    WorktreeStateJson,
    'state.json',
  )
}

/** Payload-relative path of repository.json: from artifact meta, else derived from any artifact's payloadPath. */
export function locateRepositoryJson(
  artifacts: readonly ManifestArtifact[],
  fromMeta: string | undefined,
): string | undefined {
  if (fromMeta && isSafeArchivePath(fromMeta)) return fromMeta
  for (const artifact of artifacts) {
    const segments = artifact.payloadPath.split('/').filter(Boolean)
    // projects/<projectId>/git/...
    if (segments.length >= 3 && segments[0] === 'projects' && segments[2] === GIT_PROVIDER_ID) {
      return `${segments.slice(0, 3).join('/')}/${REPOSITORY_JSON}`
    }
  }
  return undefined
}

async function isNonEmptyDirectory(
  p: string,
): Promise<{ exists: boolean; isDir: boolean; nonEmpty: boolean; isGitRepo: boolean }> {
  let stat
  try {
    stat = await fs.stat(p)
  } catch {
    return { exists: false, isDir: false, nonEmpty: false, isGitRepo: false }
  }
  if (!stat.isDirectory()) return { exists: true, isDir: false, nonEmpty: true, isGitRepo: false }
  const entries = await fs.readdir(p)
  return {
    exists: true,
    isDir: true,
    nonEmpty: entries.length > 0,
    isGitRepo: entries.includes('.git'),
  }
}

export function backupAsidePathFor(destination: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `${destination}.devmig-backup-${stamp}`
}

/**
 * Sibling paths a restore of this plan may create under `backup-then-replace`
 * (`<path>.devmig-backup-<timestamp>`). The engine adds them to the ScopedFs roots it approves;
 * unparsable state yields an empty list.
 */
export function backupAsidePathsFrom(state: Record<string, unknown>): string[] {
  const parsed = PlanState.safeParse(state)
  return parsed.success ? [...parsed.data.asidePaths] : []
}

export async function planGitRestore(
  input: ProviderRestoreInput,
  ctx: RestorePlanningContext,
): Promise<ProviderRestorePlan> {
  const providerId = GIT_PROVIDER_ID
  const preflight: PreflightCheck[] = []
  const collisions: Collision[] = []
  const steps: RestoreStep[] = []
  const warnings: string[] = []
  const blocking = (id: string, label: string, detail?: string): void => {
    preflight.push({ id, label, status: 'fail', blocking: true, ...(detail ? { detail } : {}) })
  }
  const base = (state: Record<string, unknown>): ProviderRestorePlan => ({
    providerId,
    ...(input.project ? { projectId: input.project.id } : {}),
    steps,
    collisions,
    preflight,
    remap: emptyRemap(),
    warnings,
    state,
  })

  if (!input.project) {
    blocking(
      'project',
      'Git: no project in the restore unit',
      'The Git provider has no user-wide state.',
    )
    return base({})
  }
  const selection = parseSelection(input.artifacts)
  warnings.push(...selection.warnings)
  const projectDest = input.project.newPath

  // ---- payload ----
  const repositoryJsonRel = locateRepositoryJson(input.artifacts, selection.repositoryJson)
  if (!repositoryJsonRel) {
    blocking(
      'payload',
      'Git payload is incomplete',
      'repository.json could not be located in the backup.',
    )
    return base({})
  }
  let repositoryJsonAbs: string
  let repository: RepositoryJson
  try {
    repositoryJsonAbs = safeJoin(ctx.payloadRoot, repositoryJsonRel)
    repository = await loadRepositoryJson(repositoryJsonAbs)
  } catch (err) {
    blocking('payload', 'Git payload is invalid', err instanceof Error ? err.message : String(err))
    return base({})
  }
  const providerDir = path.dirname(repositoryJsonAbs)
  const emptyRepository = repository.head === null

  // ---- primary destination ----
  // The selected directory may itself be a linked worktree. The repository (primary worktree) is then
  // restored at the mapped location of the primary and the selected worktree at the project destination.
  const primaryRecord = repository.worktrees.find((w) => w.isPrimary)
  const primaryOld = primaryRecord?.path ?? repository.primaryPath
  const selectedOld = canonicalizePath(input.project.oldPath)
  const selectedIsLinked = repository.worktrees.some(
    (w) => !w.isPrimary && canonicalizePath(w.path) === selectedOld,
  )
  let destination = projectDest
  if (selectedIsLinked && canonicalizePath(primaryOld) !== selectedOld) {
    const mapped = ctx.mapPath(primaryOld)
    destination = path.resolve(
      mapped.mapped
        ? mapped.newPath
        : path.join(path.dirname(projectDest), path.basename(primaryOld)),
    )
    warnings.push(
      `The selected directory is a linked worktree; the repository (primary worktree ${primaryOld}) is restored at ${destination}.`,
    )
  }

  // ---- git ----
  const availability = await checkGitAvailable(ctx.exec, ctx.env, ctx.signal)
  if (!availability.available) {
    preflight.push({
      id: 'git-installed',
      label: 'git is not installed',
      status: 'fail',
      blocking: true,
      detail:
        'Install the Xcode Command Line Tools (xcode-select --install) or git via Homebrew, then plan the restore again. [GIT_NOT_INSTALLED]',
    })
  } else {
    preflight.push({
      id: 'git-installed',
      label: `git available${availability.version ? ` (${availability.version.raw})` : ''}`,
      status: 'pass',
      blocking: true,
    })
    if (
      availability.version &&
      !isGitVersionAtLeast(availability.version, GIT_MIN_SUPPORTED.major, GIT_MIN_SUPPORTED.minor)
    ) {
      preflight.push({
        id: 'git-version',
        label: `git ${availability.version.major}.${availability.version.minor} is older than the tested minimum ${GIT_MIN_SUPPORTED.major}.${GIT_MIN_SUPPORTED.minor}`,
        status: 'warn',
        blocking: false,
        detail: 'Restore may still work; upgrade git if worktree or apply steps fail.',
      })
    }
  }
  const gitOk = availability.available
  const git = createGitClient(ctx.exec, { env: ctx.env, signal: ctx.signal, readOnly: true })

  // ---- bundle ----
  let bundlePath: string | null = null
  if (selection.bundle) {
    if (
      !repository.bundle.included ||
      !repository.bundle.file ||
      !isSafeArchivePath(repository.bundle.file)
    ) {
      blocking(
        'bundle',
        'Repository bundle missing from the backup',
        'The backup records no bundle for this repository.',
      )
    } else {
      bundlePath = safeJoin(providerDir, repository.bundle.file)
      if (!(await pathExists(bundlePath))) {
        blocking('bundle', 'Repository bundle missing from the payload', bundlePath)
        bundlePath = null
      } else if (gitOk) {
        const heads = await git.run(['bundle', 'list-heads', bundlePath], {
          cwd: ctx.payloadRoot,
          reject: false,
        })
        if (heads.failed) {
          blocking('bundle', 'Repository bundle is unreadable', heads.stderr.trim().slice(0, 500))
        } else {
          const refCount = heads.stdout.split('\n').filter((l) => l.trim() !== '').length
          preflight.push({
            id: 'bundle',
            label: `Repository bundle readable (${plural(refCount, 'ref')})`,
            status: 'pass',
            blocking: true,
          })
        }
      }
    }
  } else if (!emptyRepository && selection.worktreeStates.size > 0) {
    blocking(
      'bundle-required',
      'Working-tree state needs the repository',
      'Select "Repository (all branches, tags)" as well; working-tree changes can only be applied on top of the repository commits.',
    )
  }
  const restoreBundle = selection.bundle && bundlePath !== null

  // ---- names from the payload are untrusted ----
  const branchNames = new Set<string>()
  if (repository.branch) branchNames.add(repository.branch)
  for (const wt of repository.worktrees) if (wt.branch) branchNames.add(wt.branch)
  for (const name of branchNames) {
    const valid =
      isValidBranchName(name) && (!gitOk || (await checkRefFormat(git, ctx.payloadRoot, name)))
    if (!valid)
      blocking(
        `branch:${name}`,
        `Invalid branch name in backup: ${JSON.stringify(name)}`,
        'The backup is corrupted or was tampered with. [GIT_INVALID_REF]',
      )
  }
  for (const sha of [repository.head, ...repository.worktrees.map((w) => w.head)]) {
    if (sha !== null && !isSha(sha)) {
      blocking(
        'head',
        'Invalid commit id in backup',
        'The backup is corrupted or was tampered with. [GIT_INVALID_REF]',
      )
      break
    }
  }
  const remotes: RemoteRecord[] = []
  for (const remote of repository.remotes) {
    if (
      !isValidRemoteName(remote.name) ||
      !isSafeRemoteUrl(remote.fetchUrl) ||
      (remote.pushUrl !== undefined && !isSafeRemoteUrl(remote.pushUrl))
    ) {
      warnings.push(
        `Remote "${remote.name}" has an unsupported name or URL and will not be restored.`,
      )
      continue
    }
    remotes.push(remote)
  }
  const upstreams: PlanState['upstreams'] = {}
  for (const [branch, up] of Object.entries(repository.upstreams)) {
    if (!isValidBranchName(branch)) continue
    if (up.remote !== undefined && !isValidRemoteName(up.remote)) continue
    if (up.merge !== undefined && !isSafeFullRef(up.merge)) continue
    upstreams[branch] = up
  }

  // ---- destination ----
  let destinationCollisionId: string | null = null
  const dest = await isNonEmptyDirectory(destination)
  if (dest.exists && !dest.isDir) {
    blocking('destination', 'Destination exists and is not a directory', destination)
  } else if (dest.exists && dest.nonEmpty) {
    destinationCollisionId = 'destination'
    collisions.push({
      id: destinationCollisionId,
      providerId,
      projectId: input.project.id,
      kind: dest.isGitRepo ? 'git-repo-exists' : 'directory-exists',
      path: destination,
      detail: dest.isGitRepo
        ? 'A Git repository already exists at the destination. Skip (keep it) or move it aside before restoring.'
        : 'The destination directory is not empty. Skip (keep it) or move it aside before restoring.',
      allowedPolicies: COLLISION_POLICIES,
      policy: COLLISION_POLICIES.includes(ctx.defaultCollisionPolicy)
        ? ctx.defaultCollisionPolicy
        : 'skip',
    })
  } else {
    preflight.push({
      id: 'destination',
      label: dest.exists
        ? 'Destination directory is empty'
        : 'Destination does not exist yet (will be created)',
      status: 'pass',
      blocking: false,
      detail: destination,
    })
  }

  // ---- worktrees ----
  const worktrees: PlanWorktree[] = []
  const usedBranches = new Set<string>()
  if (repository.branch) usedBranches.add(repository.branch)
  let stateFiles = 0
  const stateArtifactIds: string[] = []
  const stateDirFor = async (index: number, captured: boolean): Promise<string | null> => {
    if (!captured || !selection.worktreeStates.has(index)) return null
    const dir = safeJoin(providerDir, path.join(WORKTREES_DIR, String(index)))
    try {
      const state = await loadWorktreeState(dir)
      const changed = new Set([
        ...state.stagedPaths,
        ...state.unstagedPaths,
        ...state.conflictedPaths,
      ]).size
      stateFiles += changed + state.untrackedPaths.length
      if (selection.sensitive.has(index) && state.sensitiveIncluded)
        stateFiles += state.sensitiveUntrackedPaths.length
      const id = selection.worktreeStates.get(index)
      if (id) stateArtifactIds.push(id)
      return dir
    } catch (err) {
      blocking(
        `worktree-state:${index}`,
        `Working tree state ${index} is unreadable`,
        err instanceof Error ? err.message : String(err),
      )
      return null
    }
  }
  worktrees.push({
    index: 0,
    oldPath: primaryRecord?.path ?? repository.primaryPath,
    newPath: destination,
    branch: repository.branch,
    head: repository.head,
    detached: repository.detached,
    isPrimary: true,
    stateDir: await stateDirFor(0, primaryRecord?.captured ?? false),
    includeSensitive: selection.sensitive.has(0),
    collisionId: null,
  })
  let linkedRestored = 0
  const linkedLabels: string[] = []
  for (const record of repository.worktrees) {
    if (record.isPrimary || record.index === 0) continue
    if (!selection.worktreeStates.has(record.index)) continue
    if (!restoreBundle && !emptyRepository) continue // already blocked above
    const mapped = ctx.mapPath(record.path)
    let newPath = mapped.mapped
      ? mapped.newPath
      : path.join(path.dirname(destination), path.basename(record.path))
    if (!mapped.mapped) {
      warnings.push(
        `No mapping for worktree ${record.path}; it will be recreated next to the project at ${newPath}.`,
      )
    }
    newPath = path.resolve(newPath)
    const entry: PlanWorktree = {
      index: record.index,
      oldPath: record.path,
      newPath,
      branch: record.branch,
      head: record.head,
      detached: record.detached,
      isPrimary: false,
      stateDir: await stateDirFor(record.index, record.captured),
      includeSensitive: selection.sensitive.has(record.index),
      collisionId: null,
    }
    if (newPath === destination) {
      entry.skipReason = 'its path maps onto the project directory'
    } else if (record.branch && usedBranches.has(record.branch)) {
      entry.skipReason = `branch "${record.branch}" is already checked out in another worktree`
    } else if (!record.detached && !record.branch) {
      entry.skipReason = 'it has neither a branch nor a commit'
    } else if (record.detached && !record.head) {
      entry.skipReason = 'its detached HEAD commit is unknown'
    }
    if (entry.skipReason) {
      warnings.push(
        `Worktree ${record.relativeToPrimary ?? record.path} will not be recreated: ${entry.skipReason}.`,
      )
    } else {
      if (record.branch) usedBranches.add(record.branch)
      const wtDest = await isNonEmptyDirectory(newPath)
      if (wtDest.exists && (wtDest.nonEmpty || !wtDest.isDir)) {
        entry.collisionId = `worktree:${record.index}`
        entry.backupAsidePath = backupAsidePathFor(newPath)
        collisions.push({
          id: entry.collisionId,
          providerId,
          projectId: input.project.id,
          kind: 'worktree-path-exists',
          path: newPath,
          detail: `The worktree path for ${record.branch ?? shortSha(record.head)} already exists.`,
          allowedPolicies: COLLISION_POLICIES,
          policy: COLLISION_POLICIES.includes(ctx.defaultCollisionPolicy)
            ? ctx.defaultCollisionPolicy
            : 'skip',
        })
      }
      linkedRestored += 1
      linkedLabels.push(
        `${path.basename(newPath)} (${record.branch ?? `detached @ ${shortSha(record.head)}`})`,
      )
    }
    worktrees.push(entry)
  }

  // ---- ignored entries ----
  const ignored: PlanIgnored[] = []
  const ignoredArtifactIds: string[] = []
  for (const ig of selection.ignored) {
    const target = worktrees.find((w) => w.index === ig.worktreeIndex && !w.skipReason)
    if (!target) {
      warnings.push(
        `Ignored entry ${ig.relPath} belongs to a worktree that is not restored and was skipped.`,
      )
      continue
    }
    if (!ig.payloadPath || !isSafeArchivePath(ig.payloadPath) || !isSafeArchivePath(ig.relPath)) {
      warnings.push(`Ignored entry ${ig.relPath} has an invalid payload location and was skipped.`)
      continue
    }
    const payloadPath = safeJoin(ctx.payloadRoot, ig.payloadPath)
    if (!(await pathExists(payloadPath))) {
      warnings.push(`Ignored entry ${ig.relPath} is missing from the payload and was skipped.`)
      continue
    }
    ignored.push({
      worktreeIndex: ig.worktreeIndex,
      relPath: ig.relPath,
      isDirectory: ig.isDirectory,
      payloadPath,
      label: ig.label,
    })
    ignoredArtifactIds.push(ig.artifactId)
  }

  // ---- steps ----
  if (restoreBundle && selection.bundleArtifactId) {
    steps.push({
      id: 'repository',
      providerId,
      projectId: input.project.id,
      label: 'Restore repository from bundle',
      detail: repository.detached
        ? `detached HEAD @ ${shortSha(repository.head)}, ${plural(remotes.length, 'remote')}`
        : `${repository.branch ?? 'HEAD'} @ ${shortSha(repository.head)}, ${plural(remotes.length, 'remote')}`,
      destination,
      artifactIds: [selection.bundleArtifactId],
    })
  } else if (emptyRepository) {
    steps.push({
      id: 'repository',
      providerId,
      projectId: input.project.id,
      label: 'Initialise empty repository',
      detail: `git init on ${repository.branch ?? 'main'} (the source had no commits)`,
      destination,
      artifactIds: stateArtifactIds,
    })
  }
  if (linkedRestored > 0) {
    steps.push({
      id: 'worktrees',
      providerId,
      projectId: input.project.id,
      label: `Recreate ${plural(linkedRestored, 'worktree')}`,
      detail: linkedLabels.join(', '),
      destination,
      artifactIds: stateArtifactIds,
    })
  }
  if (stateArtifactIds.length > 0) {
    steps.push({
      id: 'worktree-state',
      providerId,
      projectId: input.project.id,
      label: `Apply working tree state (${plural(stateFiles, 'file')})`,
      destination,
      artifactIds: [...stateArtifactIds, ...[...selection.sensitive.values()]],
    })
  }
  if (ignored.length > 0) {
    steps.push({
      id: 'ignored',
      providerId,
      projectId: input.project.id,
      label: `Restore ${plural(ignored.length, 'ignored entry', 'ignored entries')}`,
      detail: ignored
        .map((i) => i.relPath)
        .slice(0, 5)
        .join(', '),
      destination,
      artifactIds: ignoredArtifactIds,
    })
  }

  const backupAsidePath = backupAsidePathFor(destination)
  const asidePaths = [
    ...(destinationCollisionId ? [backupAsidePath] : []),
    ...worktrees.flatMap((w) => (w.collisionId && w.backupAsidePath ? [w.backupAsidePath] : [])),
  ]
  const state: PlanState = {
    destination,
    repositoryJson: repositoryJsonAbs,
    bundlePath,
    restoreBundle,
    emptyRepository,
    primaryBranch: repository.branch,
    head: repository.head,
    detached: repository.detached,
    remotes,
    upstreams,
    worktrees,
    ignored,
    destinationCollisionId,
    backupAsidePath,
    asidePaths,
  }
  const plan = base(state)
  plan.remap = {
    affected: [{ label: 'Git worktrees (recreated from logical state)', count: linkedRestored }],
    safeRewriteCount: linkedRestored,
    warnings: [],
    unsupportedReferences: [],
  }
  return plan
}
