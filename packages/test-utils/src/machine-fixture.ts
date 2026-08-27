/**
 * "Mac A" / "Mac B" of the Definition-of-Done scenario: a source machine with a dirty git repo,
 * a sibling worktree, Claude Code sessions/settings and a local env file, and a destination
 * machine with a different user name and an empty Claude config dir.
 */
import path from 'node:path'
import type { Exec } from '@devmig/shared'
import { createClaudeFixture, type ClaudeFixture } from './claude-fixture'
import { createFakeHome, type FakeHome } from './fake-home'
import {
  createGitRepoFixture,
  refreshGitFixtureExpectations,
  type GitRepoFixture,
} from './git-fixture'
import { assertSafeFixtureRoot } from './temp'

export const SOURCE_USER_NAME = 'alice'
export const DESTINATION_USER_NAME = 'bob'
export const SOURCE_PROJECT_NAME = 'demo'

export interface SourceMachineFixtureOptions {
  /** Default "alice". */
  userName?: string
  /** Repository directory name under <homeDir>/Documents/GitHub (default "demo"). */
  projectName?: string
  /** Claude sessions with cwd === project path (default 3). */
  sessionCount?: number
  exec?: Exec
  signal?: AbortSignal
}

export interface SourceMachineFixture {
  root: string
  home: FakeHome
  /** Git repo at <homeDir>/Documents/GitHub/<projectName>; `expected` reflects the final tree (incl. Claude project files). */
  repo: GitRepoFixture
  claude: ClaudeFixture
  projectPath: string
  /** Sibling linked worktree: <homeDir>/Documents/GitHub/<projectName>-onboarding */
  worktreePath: string
  /** Every placeholder secret planted on this machine (.env.local values, MCP token, live-session key). */
  secrets: string[]
}

/**
 * Builds "Mac A": fake home for alice + dirty git repo with worktree + Claude Code state for that
 * project (one session for the sibling worktree, one orphaned worktree session, one unrelated project).
 * The repo's `expected` snapshots are re-captured after the Claude project files are written, so
 * CLAUDE.md, .mcp.json and .nvmrc appear as untracked files in `repo.expected` (CLAUDE.local.md and
 * .claude/settings.local.json are gitignored, like .env.local).
 */
export async function createSourceMachineFixture(
  root: string,
  opts: SourceMachineFixtureOptions = {},
): Promise<SourceMachineFixture> {
  const safeRoot = assertSafeFixtureRoot(root)
  const home = await createFakeHome(safeRoot, { userName: opts.userName ?? SOURCE_USER_NAME })
  const projectName = opts.projectName ?? SOURCE_PROJECT_NAME
  const gitOpts = {
    root: home.projectsDir,
    name: projectName,
    homeDir: home.homeDir,
    withWorktree: true,
    withLocalChanges: true,
    withBinary: true,
    withIgnoredEnv: true,
    ...(opts.exec ? { exec: opts.exec } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
  const repo = await createGitRepoFixture(gitOpts)
  const worktreePath =
    repo.worktree?.path ?? path.join(home.projectsDir, `${projectName}-onboarding`)
  const claude = await createClaudeFixture({
    claudeConfigDir: home.claudeConfigDir,
    claudeJsonPath: home.claudeJsonPath,
    projectPath: repo.path,
    worktreePaths: [{ path: worktreePath, branch: repo.featureBranch }],
    otherProjectPath: path.join(home.projectsDir, 'unrelated-project'),
    ...(opts.sessionCount !== undefined ? { sessionCount: opts.sessionCount } : {}),
    includeOrphanWorktreeSession: true,
    createProjectFiles: true,
  })
  await refreshGitFixtureExpectations(repo, {
    ...(opts.exec ? { exec: opts.exec } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  return {
    root: safeRoot,
    home,
    repo,
    claude,
    projectPath: repo.path,
    worktreePath,
    secrets: [...repo.secrets, ...claude.secrets],
  }
}

export interface DestinationMachineFixtureOptions {
  /** Default "bob". */
  userName?: string
}

export interface DestinationMachineFixture {
  root: string
  home: FakeHome
}

/** Builds "Mac B": a fake home for bob whose ~/.claude exists but is empty (no projects, no ~/.claude.json). */
export async function createDestinationMachineFixture(
  root: string,
  opts: DestinationMachineFixtureOptions = {},
): Promise<DestinationMachineFixture> {
  const safeRoot = assertSafeFixtureRoot(root)
  const home = await createFakeHome(safeRoot, { userName: opts.userName ?? DESTINATION_USER_NAME })
  return { root: safeRoot, home }
}
