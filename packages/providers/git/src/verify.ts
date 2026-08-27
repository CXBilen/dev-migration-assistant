/**
 * verify for the Git provider: independent, read-only checks against the restored checkouts —
 * HEAD sha, branch, `git status --porcelain=v2` line set (minus untracked files that were deliberately
 * not restored), worktree list and remotes — each reported as a VerificationCheck.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProviderVerification, ProviderVerifyInput, VerifyContext } from '@devmig/core'
import type { VerificationCheck } from '@devmig/model'
import { realPath } from '@devmig/shared'
import { plural, shortSha } from './common'
import {
  checkGitAvailable,
  createGitClient,
  listRemotes,
  listWorktrees,
  quoteCPath,
  readHead,
  splitLines,
} from './git'
import { loadWorktreeState } from './plan'
import { GIT_PROVIDER_ID, RestoreState, type RemoteRecord } from './schema'

const MAX_DIFF_DETAILS = 5

/** Captured status lines minus the `? <path>` lines of untracked files that were not restored. */
export function expectedStatusLines(
  captured: readonly string[],
  excludedUntracked: readonly string[],
): string[] {
  if (excludedUntracked.length === 0) return [...captured].sort()
  const drop = new Set<string>()
  for (const p of excludedUntracked) {
    drop.add(`? ${p}`)
    drop.add(`? ${quoteCPath(p)}`)
  }
  return captured.filter((line) => !drop.has(line)).sort()
}

export function diffLineSets(expected: readonly string[], actual: readonly string[]): string[] {
  const exp = new Set(expected)
  const act = new Set(actual)
  const out: string[] = []
  for (const line of expected) if (!act.has(line)) out.push(`missing: ${line}`)
  for (const line of actual) if (!exp.has(line)) out.push(`unexpected: ${line}`)
  return out
}

function remoteKey(r: RemoteRecord): string {
  return `${r.name} ${r.fetchUrl}${r.pushUrl !== undefined && r.pushUrl !== r.fetchUrl ? ` (push ${r.pushUrl})` : ''}`
}

export async function verifyGitRestore(
  input: ProviderVerifyInput,
  ctx: VerifyContext,
): Promise<ProviderVerification> {
  const checks: VerificationCheck[] = []
  const projectId = input.input.project?.id
  const base = { providerId: GIT_PROVIDER_ID, ...(projectId ? { projectId } : {}) }
  const parsed = RestoreState.safeParse(input.result.state ?? {})
  if (!parsed.success) {
    checks.push({
      id: 'state',
      label: 'Git: no verification data from the restore step',
      status: 'warn',
      ...base,
    })
    return { checks }
  }
  const state = parsed.data
  if (state.skipped) {
    checks.push({
      id: 'skipped',
      label: 'Repository restore was skipped (destination existed)',
      status: 'warn',
      detail: state.destination,
      ...base,
    })
    return { checks }
  }
  const availability = await checkGitAvailable(ctx.exec, ctx.env, ctx.signal)
  if (!availability.available) {
    checks.push({
      id: 'git',
      label: 'git is not available for verification',
      status: 'fail',
      ...base,
    })
    return { checks }
  }
  const git = createGitClient(ctx.exec, { env: ctx.env, signal: ctx.signal, readOnly: true })

  for (const wt of state.worktrees) {
    const label = wt.isPrimary ? 'Working tree' : `Worktree ${path.basename(wt.newPath)}`
    const idBase = `worktree:${wt.index}`
    if (!wt.created) {
      checks.push({
        id: `${idBase}:created`,
        label: `${label} was not recreated`,
        status: 'warn',
        detail: wt.newPath,
        ...base,
      })
      continue
    }
    let exists: boolean
    try {
      exists = (await fs.stat(wt.newPath)).isDirectory()
    } catch {
      exists = false
    }
    if (!exists) {
      checks.push({
        id: `${idBase}:exists`,
        label: `${label} is missing`,
        status: 'fail',
        detail: wt.newPath,
        ...base,
      })
      continue
    }
    const head = await readHead(git, wt.newPath)
    checks.push(
      head.head === wt.expectedHead
        ? {
            id: `${idBase}:head`,
            label: `${label} HEAD @ ${shortSha(head.head) || 'unborn'}`,
            status: 'pass',
            ...base,
          }
        : {
            id: `${idBase}:head`,
            label: `${label} HEAD mismatch`,
            status: 'fail',
            detail: `expected ${wt.expectedHead ?? 'unborn'}, found ${head.head ?? 'unborn'}`,
            ...base,
          },
    )
    const branchOk = wt.expectedDetached ? head.detached : head.branch === wt.expectedBranch
    checks.push(
      branchOk
        ? {
            id: `${idBase}:branch`,
            label: `${label} on ${wt.expectedDetached ? 'detached HEAD' : (wt.expectedBranch ?? 'no branch')}`,
            status: 'pass',
            ...base,
          }
        : {
            id: `${idBase}:branch`,
            label: `${label} branch mismatch`,
            status: 'fail',
            detail: `expected ${wt.expectedDetached ? 'detached HEAD' : (wt.expectedBranch ?? 'no branch')}, found ${head.detached ? 'detached HEAD' : (head.branch ?? 'no branch')}`,
            ...base,
          },
    )

    const statusRes = await git.run(
      ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--untracked-files=all'],
      { cwd: wt.newPath, reject: false },
    )
    if (statusRes.failed) {
      checks.push({
        id: `${idBase}:status`,
        label: `${label} status could not be read`,
        status: 'fail',
        detail: statusRes.stderr.trim().slice(0, 300),
        ...base,
      })
      continue
    }
    const actual = splitLines(statusRes.stdout).sort()
    if (wt.stateDir) {
      let expected: string[]
      try {
        const captured = await loadWorktreeState(wt.stateDir)
        const excluded = [
          ...captured.excludedUntrackedPaths,
          ...(wt.sensitiveRestored ? [] : captured.sensitiveUntrackedPaths),
        ]
        expected = expectedStatusLines(captured.statusLines, excluded)
      } catch (err) {
        checks.push({
          id: `${idBase}:status`,
          label: `${label} captured state unreadable`,
          status: 'warn',
          detail: err instanceof Error ? err.message : String(err),
          ...base,
        })
        continue
      }
      const differences = diffLineSets(expected, actual)
      checks.push(
        differences.length === 0
          ? {
              id: `${idBase}:status`,
              label: `${label} status matches (${plural(expected.length, 'entry', 'entries')})`,
              status: 'pass',
              ...base,
            }
          : {
              id: `${idBase}:status`,
              label: `${label} status differs (${plural(differences.length, 'difference')})`,
              status: 'fail',
              detail: `${differences.slice(0, MAX_DIFF_DETAILS).join('; ')}${differences.length > MAX_DIFF_DETAILS ? '; …' : ''}${wt.applyFailed ? ' (working-tree changes could not be applied)' : ''}`,
              ...base,
            },
      )
    } else {
      checks.push(
        actual.length === 0
          ? {
              id: `${idBase}:status`,
              label: `${label} is clean (no state was selected)`,
              status: 'pass',
              ...base,
            }
          : {
              id: `${idBase}:status`,
              label: `${label} is not clean although no state was selected`,
              status: 'warn',
              detail: actual.slice(0, MAX_DIFF_DETAILS).join('; '),
              ...base,
            },
      )
    }
  }

  // ---- worktree list ----
  const listed = (await listWorktrees(git, state.destination)).filter((w) => !w.bare)
  const expectedWorktrees = state.worktrees.filter((w) => w.created)
  const listedPaths = new Set<string>()
  for (const entry of listed) listedPaths.add(await realPath(entry.path))
  const missing: string[] = []
  for (const wt of expectedWorktrees) {
    if (!listedPaths.has(await realPath(wt.newPath))) missing.push(wt.newPath)
  }
  const listedBranches = listed.map((w) => w.branch ?? '(detached)').sort()
  const expectedBranches = expectedWorktrees
    .map((w) => (w.expectedDetached ? '(detached)' : (w.expectedBranch ?? '(detached)')))
    .sort()
  const branchesEqual = JSON.stringify(listedBranches) === JSON.stringify(expectedBranches)
  checks.push(
    missing.length === 0 && listed.length === expectedWorktrees.length && branchesEqual
      ? {
          id: 'worktrees',
          label: `${plural(listed.length, 'worktree')} registered`,
          status: 'pass',
          detail: listedBranches.join(', '),
          ...base,
        }
      : {
          id: 'worktrees',
          label: 'Worktree list differs from the backup',
          status: 'fail',
          detail: `expected ${expectedWorktrees.length} (${expectedBranches.join(', ')}), found ${listed.length} (${listedBranches.join(', ')})${missing.length ? `; missing: ${missing.join(', ')}` : ''}`,
          ...base,
        },
  )

  // ---- remotes ----
  const actualRemotes = await listRemotes(git, state.destination)
  const remoteDiff = diffLineSets(
    state.remotes.map(remoteKey).sort(),
    actualRemotes.map(remoteKey).sort(),
  )
  checks.push(
    remoteDiff.length === 0
      ? {
          id: 'remotes',
          label: `${plural(actualRemotes.length, 'remote')} configured`,
          status: 'pass',
          detail: actualRemotes.map((r) => r.name).join(', ') || undefined,
          ...base,
        }
      : {
          id: 'remotes',
          label: 'Remotes differ from the backup',
          status: 'fail',
          detail: remoteDiff.slice(0, MAX_DIFF_DETAILS).join('; '),
          ...base,
        },
  )
  return { checks }
}
