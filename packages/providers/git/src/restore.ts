/**
 * restore for the Git provider. Writes only through ctx.fs (roots = approved destinations) and runs
 * git with `-c core.hooksPath=/dev/null` for every mutating command so hooks shipped inside the
 * restored content (or the user's init templates) can never execute during a restore.
 *
 * Algorithm: mkdir dest → git init → symbolic-ref HEAD → bundle verify + fetch → checkout/reset →
 * remotes + upstreams → worktree add per linked worktree → per worktree: apply staged diff (--index),
 * apply unstaged diff, copy untracked files → copy selected ignored entries.
 */
import path from 'node:path'
import type {
  ProviderRestoreInput,
  ProviderRestorePlan,
  ProviderRestoreResult,
  RestoreContext,
} from '@devmig/core'
import type { CollisionPolicy, ResultItem } from '@devmig/model'
import {
  MigrationError,
  pathExists,
  safeJoin,
  throwIfAborted,
  type ExecResult,
} from '@devmig/shared'
import { plural, shortSha } from './common'
import {
  assertSafeArg,
  assertSafeBranchName,
  assertSafeRemoteName,
  assertSha,
  createGitClient,
  isSafeFullRef,
  isSafeRemoteUrl,
  isValidBranchName,
  isValidRemoteName,
  refExists,
  type GitClient,
  type GitRunOptions,
} from './git'
import { loadWorktreeState } from './plan'
import {
  GIT_PROVIDER_ID,
  PlanState,
  STAGED_DIFF,
  UNAPPLIED_DIR,
  UNSTAGED_DIFF,
  UNTRACKED_DIR,
  UNTRACKED_SENSITIVE_DIR,
  type PlanWorktree,
  type RestoreState,
  type RestoredWorktree,
} from './schema'

/** Prevents repository hooks from running during restore (checkout, worktree add, apply, fetch…). */
export const HOOK_GUARD_ARGS = ['-c', 'core.hooksPath=/dev/null'] as const
const FETCH_TIMEOUT_MS = 60 * 60_000
const APPLY_TIMEOUT_MS = 30 * 60_000
const BUNDLE_REFSPECS = [
  '+refs/heads/*:refs/heads/*',
  '+refs/tags/*:refs/tags/*',
  '+refs/remotes/*:refs/remotes/*',
] as const

type Mutate = (
  args: readonly string[],
  cwd: string,
  options?: Omit<GitRunOptions, 'cwd'>,
) => Promise<ExecResult>

function createMutator(git: GitClient, ctx: RestoreContext): Mutate {
  return async (args, cwd, options = {}) => {
    // Every mutating git call runs with a cwd inside the approved destinations (symlink-checked).
    await ctx.fs.assertAllowed(cwd)
    throwIfAborted(ctx.signal)
    return git.run([...HOOK_GUARD_ARGS, ...args], { cwd, ...options })
  }
}

async function ensureDirectory(ctx: RestoreContext, dir: string): Promise<void> {
  if (await pathExists(dir)) {
    const stat = await ctx.fs.stat(dir)
    if (!stat.isDirectory()) {
      throw new MigrationError('NOT_A_DIRECTORY', `Destination is not a directory: ${dir}`)
    }
    return
  }
  try {
    await ctx.fs.mkdir(dir, 0o755)
  } catch (err) {
    if (err instanceof MigrationError && err.code === 'PATH_OUTSIDE_ALLOWED_ROOT') {
      throw new MigrationError(
        'PATH_OUTSIDE_ALLOWED_ROOT',
        `Cannot create the destination directory ${dir}.`,
        {
          hint: 'Create the (empty) destination folder yourself and run the restore again.',
          details: { path: dir },
          cause: err,
        },
      )
    }
    throw err
  }
}

async function moveAside(
  ctx: RestoreContext,
  from: string,
  to: string,
  items: ResultItem[],
): Promise<void> {
  if (!ctx.fs.isAllowed(to)) {
    throw new MigrationError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      `Cannot move the existing directory aside: ${to} is outside the approved destinations.`,
      {
        hint: 'Choose "skip" for this collision or move the existing directory away manually.',
        details: { from, to },
      },
    )
  }
  await ctx.fs.rename(from, to)
  items.push({
    label: `Existing directory moved to ${path.basename(to)}`,
    status: 'info',
    detail: to,
  })
}

function policyFor(ctx: RestoreContext, collisionId: string | null): CollisionPolicy {
  if (!collisionId) return 'skip'
  return ctx.collisionDecisions[collisionId] ?? 'skip'
}

async function applyWorktreeState(
  entry: RestoredWorktree,
  planned: PlanWorktree,
  mutate: Mutate,
  ctx: RestoreContext,
  items: ResultItem[],
  warnings: string[],
): Promise<void> {
  const stateDir = entry.stateDir
  if (!stateDir) return
  const state = await loadWorktreeState(stateDir)
  const cwd = entry.newPath
  const where = entry.isPrimary ? 'working tree' : `worktree ${path.basename(cwd)}`
  const stagedFile = path.join(stateDir, state.stagedDiff.file)
  const unstagedFile = path.join(stateDir, state.unstagedDiff.file)
  assertSafeArg(stagedFile, 'diff path')
  assertSafeArg(unstagedFile, 'diff path')

  let failure: { kind: 'staged' | 'unstaged'; stderr: string } | undefined
  if (!state.stagedDiff.empty) {
    const res = await mutate(
      ['apply', '--index', '--binary', '--whitespace=nowarn', '--', stagedFile],
      cwd,
      {
        reject: false,
        timeoutMs: APPLY_TIMEOUT_MS,
      },
    )
    if (res.failed) failure = { kind: 'staged', stderr: res.stderr }
  }
  if (!failure && !state.unstagedDiff.empty) {
    const res = await mutate(
      ['apply', '--binary', '--whitespace=nowarn', '--', unstagedFile],
      cwd,
      {
        reject: false,
        timeoutMs: APPLY_TIMEOUT_MS,
      },
    )
    if (res.failed) failure = { kind: 'unstaged', stderr: res.stderr }
  }
  if (failure) {
    entry.applyFailed = true
    const unapplied = path.join(cwd, UNAPPLIED_DIR)
    // Nothing is lost: keep the diff files next to the restored checkout.
    if (!state.stagedDiff.empty)
      await ctx.fs.copyFile(stagedFile, path.join(unapplied, STAGED_DIFF))
    if (!state.unstagedDiff.empty)
      await ctx.fs.copyFile(unstagedFile, path.join(unapplied, UNSTAGED_DIFF))
    const error = new MigrationError(
      'GIT_APPLY_FAILED',
      `The ${failure.kind} changes of the ${where} could not be applied: ${failure.stderr.trim().slice(0, 500)}`,
      {
        hint: `The repository was restored; the working-tree changes could not be applied automatically. The diff files were placed in ${UNAPPLIED_DIR}/ inside the checkout.`,
        details: { worktree: cwd, kind: failure.kind },
        recoverable: true,
      },
    )
    ctx.logger.warn('git apply failed', {
      worktree: cwd,
      kind: failure.kind,
      stderr: failure.stderr.slice(0, 500),
    })
    items.push({ label: `${error.message} [${error.code}]`, status: 'error', detail: error.hint })
    warnings.push(`${error.message} ${error.hint ?? ''}`.trim())
  } else {
    entry.stateApplied = true
  }

  let copied = 0
  const untrackedDir = path.join(stateDir, UNTRACKED_DIR)
  if (await pathExists(untrackedDir)) {
    const result = await ctx.fs.copyDir(untrackedDir, cwd)
    copied += result.files
  }
  if (planned.includeSensitive && state.sensitiveIncluded) {
    const sensitiveDir = path.join(stateDir, UNTRACKED_SENSITIVE_DIR)
    if (await pathExists(sensitiveDir)) {
      const result = await ctx.fs.copyDir(sensitiveDir, cwd)
      copied += result.files
      entry.sensitiveRestored = true
    }
  }
  const changed = new Set([...state.stagedPaths, ...state.unstagedPaths, ...state.conflictedPaths])
    .size
  if (!failure) {
    items.push({
      label: `${entry.isPrimary ? 'Working tree' : `Worktree ${path.basename(cwd)}`}: ${plural(changed, 'changed file')}, ${plural(copied, 'untracked file')} restored`,
      status: 'ok',
      detail: cwd,
    })
  } else if (copied > 0) {
    items.push({
      label: `${where}: ${plural(copied, 'untracked file')} restored`,
      status: 'ok',
      detail: cwd,
    })
  }
}

export async function restoreGit(
  plan: ProviderRestorePlan,
  input: ProviderRestoreInput,
  ctx: RestoreContext,
): Promise<ProviderRestoreResult> {
  const parsed = PlanState.safeParse(plan.state)
  if (!parsed.success) {
    throw new MigrationError('PROVIDER_FAILED', 'The Git restore plan state is invalid.', {
      details: {
        issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    })
  }
  const state = parsed.data
  const items: ResultItem[] = []
  const warnings: string[] = []
  const restored: RestoreState = {
    destination: state.destination,
    skipped: false,
    worktrees: [],
    remotes: [],
  }
  const projectId = input.project?.id
  const finish = (status: ProviderRestoreResult['status']): ProviderRestoreResult => ({
    providerId: GIT_PROVIDER_ID,
    ...(projectId ? { projectId } : {}),
    status,
    items,
    warnings,
    state: restored,
  })
  const dest = state.destination

  // ---- destination collision ----
  if (state.destinationCollisionId) {
    const policy = policyFor(ctx, state.destinationCollisionId)
    if (policy === 'skip') {
      items.push({
        label: `Repository restore skipped: ${dest} already exists`,
        status: 'warn',
        detail: dest,
      })
      warnings.push(
        `Destination ${dest} already exists; the repository was not restored (collision policy: skip).`,
      )
      restored.skipped = true
      return finish('skipped')
    }
    if (policy === 'backup-then-replace') {
      await moveAside(ctx, dest, state.backupAsidePath, items)
    } else {
      throw new MigrationError(
        'INVALID_INPUT',
        `Unsupported collision policy for the Git provider: ${policy}`,
      )
    }
  }

  const git = createGitClient(ctx.exec, { env: ctx.env, signal: ctx.signal, readOnly: false })
  const mutate = createMutator(git, ctx)

  // ---- repository ----
  ctx.progress(`Initialising repository at ${dest}`)
  await ensureDirectory(ctx, dest)
  await mutate(['-c', 'init.defaultBranch=main', 'init', '--quiet'], dest)
  const branch = state.primaryBranch !== null ? assertSafeBranchName(state.primaryBranch) : null
  if (branch) await mutate(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], dest)

  if (state.restoreBundle && state.bundlePath) {
    const bundle = assertSafeArg(state.bundlePath, 'bundle path')
    ctx.progress('Verifying repository bundle…', undefined, {
      id: 'git:repository',
      label: 'Repository',
      status: 'running',
    })
    const verified = await mutate(['bundle', 'verify', '--quiet', bundle], dest, { reject: false })
    if (verified.failed) {
      throw new MigrationError('GIT_BUNDLE_FAILED', 'The repository bundle failed verification.', {
        details: { stderr: verified.stderr.trim().slice(0, 1000) },
        hint: 'The backup may be corrupted. Verify the backup file and try again.',
      })
    }
    ctx.progress('Fetching repository from bundle…')
    await mutate(['fetch', '--quiet', '--update-head-ok', bundle, ...BUNDLE_REFSPECS], dest, {
      timeoutMs: FETCH_TIMEOUT_MS,
    })
    if (state.detached && state.head) {
      // A detached HEAD may point at a commit no ref contains; the bundle carries it as HEAD.
      await mutate(['fetch', '--quiet', bundle, 'HEAD'], dest, {
        reject: false,
        timeoutMs: FETCH_TIMEOUT_MS,
      })
    }
  }

  if (state.detached && state.head) {
    const sha = assertSha(state.head)
    await mutate(['checkout', '--quiet', '--detach', sha], dest)
  } else if (branch && state.head) {
    await mutate(['reset', '--quiet', '--hard'], dest)
  }
  items.push({
    label: state.restoreBundle
      ? `Repository restored (${state.detached ? `detached @ ${shortSha(state.head)}` : `${branch ?? 'HEAD'} @ ${shortSha(state.head)}`})`
      : `Empty repository initialised on ${branch ?? 'main'}`,
    status: 'ok',
    detail: dest,
  })
  ctx.progress('✓ Repository', undefined, {
    id: 'git:repository',
    label: 'Repository',
    status: 'done',
  })

  // ---- remotes + upstreams ----
  for (const remote of state.remotes) {
    throwIfAborted(ctx.signal)
    try {
      const name = assertSafeRemoteName(remote.name)
      if (!isSafeRemoteUrl(remote.fetchUrl))
        throw new MigrationError('INVALID_INPUT', 'unsafe remote URL')
      await mutate(['remote', 'add', name, remote.fetchUrl], dest)
      if (remote.pushUrl !== undefined && remote.pushUrl !== remote.fetchUrl) {
        if (!isSafeRemoteUrl(remote.pushUrl))
          throw new MigrationError('INVALID_INPUT', 'unsafe push URL')
        await mutate(['remote', 'set-url', '--push', name, remote.pushUrl], dest)
      }
      restored.remotes.push(remote)
    } catch (err) {
      if (err instanceof MigrationError && err.code === 'CANCELLED') throw err
      warnings.push(
        `Remote "${remote.name}" could not be restored: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  if (restored.remotes.length > 0) {
    items.push({
      label: `${plural(restored.remotes.length, 'remote')} configured`,
      status: 'ok',
      detail: restored.remotes.map((r) => r.name).join(', '),
    })
  }
  for (const [b, up] of Object.entries(state.upstreams)) {
    throwIfAborted(ctx.signal)
    if (!isValidBranchName(b) || !up.remote || !up.merge) continue
    if (!isValidRemoteName(up.remote) || !isSafeFullRef(up.merge)) continue
    if (!restored.remotes.some((r) => r.name === up.remote)) continue
    if (!(await refExists(git, dest, `refs/heads/${b}`))) continue
    await mutate(['config', `branch.${b}.remote`, up.remote], dest)
    await mutate(['config', `branch.${b}.merge`, up.merge], dest)
  }

  // ---- worktrees ----
  const primaryPlan = state.worktrees.find((w) => w.isPrimary)
  restored.worktrees.push({
    index: 0,
    newPath: dest,
    isPrimary: true,
    created: true,
    stateDir: primaryPlan?.stateDir ?? null,
    stateApplied: false,
    applyFailed: false,
    sensitiveRestored: false,
    expectedHead: state.head,
    expectedBranch: state.primaryBranch,
    expectedDetached: state.detached,
  })
  for (const wt of state.worktrees) {
    if (wt.isPrimary) continue
    throwIfAborted(ctx.signal)
    const entry: RestoredWorktree = {
      index: wt.index,
      newPath: wt.newPath,
      isPrimary: false,
      created: false,
      stateDir: wt.stateDir,
      stateApplied: false,
      applyFailed: false,
      sensitiveRestored: false,
      expectedHead: wt.head,
      expectedBranch: wt.branch,
      expectedDetached: wt.detached,
    }
    restored.worktrees.push(entry)
    const label = `Worktree ${path.basename(wt.newPath)}`
    if (wt.skipReason) {
      items.push({
        label: `${label} skipped: ${wt.skipReason}`,
        status: 'warn',
        detail: wt.newPath,
      })
      continue
    }
    if (wt.collisionId) {
      const policy = policyFor(ctx, wt.collisionId)
      if (policy === 'skip') {
        items.push({
          label: `${label} skipped: ${wt.newPath} already exists`,
          status: 'warn',
          detail: wt.newPath,
        })
        warnings.push(`Worktree path ${wt.newPath} already exists; the worktree was not recreated.`)
        continue
      }
      if (policy === 'backup-then-replace') {
        await moveAside(ctx, wt.newPath, wt.backupAsidePath ?? backupAsideFor(wt.newPath), items)
      }
    }
    if (!ctx.fs.isAllowed(wt.newPath)) {
      items.push({
        label: `${label} skipped: outside the approved destinations`,
        status: 'warn',
        detail: wt.newPath,
      })
      warnings.push(
        `Worktree ${wt.newPath} is outside the approved destinations and was not recreated.`,
      )
      continue
    }
    try {
      if (wt.detached || !wt.branch) {
        const sha = assertSha(wt.head ?? '')
        await mutate(['worktree', 'add', '--quiet', '--detach', '--', wt.newPath, sha], dest)
      } else {
        const wtBranch = assertSafeBranchName(wt.branch)
        await mutate(['worktree', 'add', '--quiet', '--', wt.newPath, wtBranch], dest)
      }
      entry.created = true
      items.push({
        label: `${label} on ${wt.branch ?? `detached @ ${shortSha(wt.head)}`}`,
        status: 'ok',
        detail: wt.newPath,
      })
    } catch (err) {
      if (err instanceof MigrationError && err.code === 'CANCELLED') throw err
      const message = err instanceof Error ? err.message : String(err)
      items.push({ label: `${label} could not be recreated`, status: 'error', detail: message })
      warnings.push(`Worktree ${wt.newPath} could not be recreated: ${message}`)
    }
  }
  ctx.progress(
    `✓ ${plural(restored.worktrees.filter((w) => w.created && !w.isPrimary).length, 'worktree')} recreated`,
  )

  // ---- working tree state ----
  for (const entry of restored.worktrees) {
    throwIfAborted(ctx.signal)
    if (!entry.created || !entry.stateDir) continue
    const planned = state.worktrees.find((w) => w.index === entry.index)
    if (!planned) continue
    ctx.progress(`Applying working tree state to ${path.basename(entry.newPath)}…`)
    await applyWorktreeState(entry, planned, mutate, ctx, items, warnings)
  }

  // ---- ignored entries ----
  for (const ig of state.ignored) {
    throwIfAborted(ctx.signal)
    const target = restored.worktrees.find((w) => w.index === ig.worktreeIndex)
    if (!target?.created) {
      warnings.push(`Ignored entry ${ig.relPath} skipped: its worktree was not restored.`)
      continue
    }
    const destPath = safeJoin(target.newPath, ig.relPath)
    if (await pathExists(destPath)) {
      warnings.push(
        `Ignored entry ${ig.relPath} already exists at the destination and was left untouched.`,
      )
      items.push({ label: `${ig.relPath} kept (already exists)`, status: 'warn', detail: destPath })
      continue
    }
    if (ig.isDirectory) await ctx.fs.copyDir(ig.payloadPath, destPath)
    else await ctx.fs.copyFile(ig.payloadPath, destPath)
    items.push({ label: `${ig.relPath} restored`, status: 'ok', detail: destPath })
  }

  const status = items.some((i) => i.status === 'error') ? 'partial' : 'ok'
  return finish(status)
}

function backupAsideFor(target: string): string {
  return `${target}.devmig-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
}
