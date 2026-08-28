import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Exec } from '@devmig/shared'
import { MigrationError, realExec, throwIfAborted } from '@devmig/shared'
import { seededBytes } from './ids'
import {
  assertSafeArg,
  assertSafeBranchName,
  bindExecEnv,
  createGitRunner,
  gitTestEnv,
  type GitRunner,
} from './git-env'
import { relativeWorktreeShape } from './git-parsers'
import { captureGitState, type GitStateSnapshot } from './git-state'
import { assertSafeFixtureRoot } from './temp'

export const DEFAULT_REMOTE_URL = 'https://github.com/example/demo.git'
export const FIXTURE_PRIMARY_BRANCH = 'main'
export const FIXTURE_FEATURE_BRANCH = 'feature/onboarding'
export const FIXTURE_WORKTREE_SUFFIX = '-onboarding'

/** Secrets written into the ignored .env.local. Tests assert these never appear in logs/manifests. */
export const FIXTURE_ENV_SECRETS = {
  API_KEY: 'sk-test-1234567890abcdef',
  DATABASE_URL: 'postgres://u:p@localhost/db',
} as const

/** Lines of the committed .gitignore (`.env*` and `node_modules/` are the ones tests rely on). */
export const FIXTURE_GITIGNORE_LINES = [
  '.env*',
  'node_modules/',
  'CLAUDE.local.md',
  '.claude/settings.local.json',
] as const

export interface GitRepoFixtureOptions {
  /** Temp/artifact directory the repo (and its sibling worktree) are created in. */
  root: string
  /** Directory name of the repository under root. */
  name: string
  remoteUrl?: string
  /** Add a linked worktree at <root>/<name>-onboarding on feature/onboarding (default true). */
  withWorktree?: boolean
  /** Dirty the working trees with staged/unstaged/untracked changes (default true). */
  withLocalChanges?: boolean
  /** Commit assets/logo.png and modify it unstaged (default true). */
  withBinary?: boolean
  /** Write the ignored .env.local with fake secrets (default true). */
  withIgnoredEnv?: boolean
  /**
   * Extra files whose names are deliberately hostile (leading `-`, newline, quotes, backslash, an
   * NFC/NFD pair). Names are written verbatim: `NAME_RE`/`assertRepoName` guards the repository
   * *directory* name, never file entries, and every git call receives these names as whole argv
   * elements after a `--` separator, so a leading `-` can never be read as an option.
   * `ignored` names may not contain a newline (`.gitignore` is line-based).
   */
  hostileNames?: {
    committed?: readonly string[]
    untracked?: readonly string[]
    ignored?: readonly string[]
  }
  /** HOME for the deterministic git environment (default: root). Use the fake home when you have one. */
  homeDir?: string
  exec?: Exec
  signal?: AbortSignal
}

/** Repo-relative POSIX paths (or absolute paths, see GitRepoFixture.files) of everything the fixture created. */
export interface GitFixtureFiles {
  readme: string
  gitignore: string
  indexTs: string
  packageJson: string
  utilTs: string
  /** Only exists on feature/onboarding (and therefore in the linked worktree). */
  onboardingTs: string
  logo?: string
  newStaged?: string
  todo?: string
  envLocal?: string
  nodeModulesJunk?: string
}

export interface GitWorktreeFixture {
  /** Absolute path (sibling of the primary checkout). */
  path: string
  branch: typeof FIXTURE_FEATURE_BRANCH
  head: string
  /** "../<name>-onboarding" */
  relativeToPrimary: string
  files: { modified?: string; untracked?: string }
  expected: GitStateSnapshot
}

export interface GitRepoFixture {
  path: string
  name: string
  primaryBranch: typeof FIXTURE_PRIMARY_BRANCH
  /** HEAD of the primary checkout (== last commit on main). */
  head: string
  /** Commits on main, oldest first. */
  commits: string[]
  featureBranch: typeof FIXTURE_FEATURE_BRANCH
  featureHead: string
  remoteName: 'origin'
  remoteUrl: string
  worktree?: GitWorktreeFixture
  /** Absolute paths of the files the fixture created (optional ones only when enabled). */
  files: GitFixtureFiles
  /** Same keys as `files`, repo-relative POSIX paths. */
  relativePaths: GitFixtureFiles
  /** Deterministic git environment used to build the fixture; pass it to every git call. */
  env: Record<string, string>
  /** realExec (or the injected exec) with `env` pre-bound. */
  exec: Exec
  /** Snapshot of the primary checkout taken right after creation. */
  expected: GitStateSnapshot
  /** Secret values placed in .env.local (empty when withIgnoredEnv is false). */
  secrets: string[]
  /** Repo-relative POSIX paths written from `hostileNames` (all empty when the option is unused). */
  hostilePaths: { committed: string[]; untracked: string[]; ignored: string[] }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/
const REMOTE_URL_RE = /^(https?:\/\/|ssh:\/\/|git@)[A-Za-z0-9._~:/@%+-]+$/

function assertRepoName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new MigrationError('INVALID_INPUT', `Invalid fixture repository name: ${name}`)
  }
  return name
}

function assertRemoteUrl(url: string): string {
  assertSafeArg(url, 'remote URL')
  if (!REMOTE_URL_RE.test(url)) {
    throw new MigrationError('INVALID_INPUT', `Unsupported fixture remote URL: ${url}`)
  }
  return url
}

function commitDate(index: number): string {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0)
  return new Date(base + index * 60_000).toISOString()
}

async function writeText(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
}

/** PNG signature followed by deterministic pseudo-random bytes (contains NULs, so git treats it as binary). */
export function fixtureBinary(seed: number, length = 1024): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    seededBytes(seed, length),
  ])
}

async function initRepo(git: GitRunner, repoPath: string): Promise<void> {
  await fs.mkdir(repoPath, { recursive: true })
  await git(['-c', 'init.defaultBranch=main', 'init', '--quiet'], repoPath)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], repoPath)
  await git(['config', 'user.name', 'Fixture User'], repoPath)
  await git(['config', 'user.email', 'fixture@example.com'], repoPath)
  await git(['config', 'commit.gpgsign', 'false'], repoPath)
  await git(['config', 'core.autocrlf', 'false'], repoPath)
}

async function commitAll(
  git: GitRunner,
  repoPath: string,
  message: string,
  index: number,
): Promise<string> {
  assertSafeArg(message, 'commit message')
  const date = commitDate(index)
  await git(['add', '--all'], repoPath)
  await git(['commit', '--quiet', '--no-verify', '-m', message], repoPath, {
    env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  })
  return (await git(['rev-parse', 'HEAD'], repoPath)).stdout.trim()
}

function absoluteFiles(repoPath: string, rel: GitFixtureFiles): GitFixtureFiles {
  const abs = (r: string): string => path.join(repoPath, ...r.split('/'))
  const out: GitFixtureFiles = {
    readme: abs(rel.readme),
    gitignore: abs(rel.gitignore),
    indexTs: abs(rel.indexTs),
    packageJson: abs(rel.packageJson),
    utilTs: abs(rel.utilTs),
    onboardingTs: abs(rel.onboardingTs),
  }
  if (rel.logo !== undefined) out.logo = abs(rel.logo)
  if (rel.newStaged !== undefined) out.newStaged = abs(rel.newStaged)
  if (rel.todo !== undefined) out.todo = abs(rel.todo)
  if (rel.envLocal !== undefined) out.envLocal = abs(rel.envLocal)
  if (rel.nodeModulesJunk !== undefined) out.nodeModulesJunk = abs(rel.nodeModulesJunk)
  return out
}

/**
 * Builds the canonical dirty repository used across the test-suite:
 * 3 commits on main, feature/onboarding with one extra commit, a remote (never contacted),
 * a sibling linked worktree, and staged/unstaged/untracked/binary/ignored local changes.
 *
 * Resulting `git status --porcelain=v2 --untracked-files=all` of the primary checkout (defaults):
 *   1 M. ... src/index.ts        (staged modification)
 *   1 A. ... src/new-staged.ts   (staged new file)
 *   1 .M ... README.md           (unstaged modification)
 *   1 .M ... assets/logo.png     (unstaged binary modification)
 *   ? notes/todo.md              (untracked)
 * `.env.local` and `node_modules/junk.js` are ignored and never appear.
 */
export async function createGitRepoFixture(opts: GitRepoFixtureOptions): Promise<GitRepoFixture> {
  const root = assertSafeFixtureRoot(opts.root)
  const name = assertRepoName(opts.name)
  const remoteUrl = assertRemoteUrl(opts.remoteUrl ?? DEFAULT_REMOTE_URL)
  const withWorktree = opts.withWorktree ?? true
  const withLocalChanges = opts.withLocalChanges ?? true
  const withBinary = opts.withBinary ?? true
  const withIgnoredEnv = opts.withIgnoredEnv ?? true
  const baseExec = opts.exec ?? realExec
  const env = gitTestEnv(opts.homeDir === undefined ? root : assertSafeFixtureRoot(opts.homeDir))
  const exec = bindExecEnv(baseExec, env)
  const signalOpts = opts.signal ? { signal: opts.signal } : {}
  const git = createGitRunner(baseExec, env, signalOpts)

  const repoPath = path.join(root, name)
  if (await fs.stat(repoPath).catch(() => null)) {
    throw new MigrationError(
      'RESTORE_DESTINATION_EXISTS',
      `Fixture path already exists: ${repoPath}`,
    )
  }
  throwIfAborted(opts.signal)
  await initRepo(git, repoPath)

  const rel: GitFixtureFiles = {
    readme: 'README.md',
    gitignore: '.gitignore',
    indexTs: 'src/index.ts',
    packageJson: 'package.json',
    utilTs: 'src/util.ts',
    onboardingTs: 'src/onboarding.ts',
  }
  const abs = (r: string): string => path.join(repoPath, ...r.split('/'))

  // Commit 1: README + .gitignore
  await writeText(abs(rel.readme), '# demo\n\nA fixture project.\n')
  await writeText(abs(rel.gitignore), `${FIXTURE_GITIGNORE_LINES.join('\n')}\n`)
  const commits: string[] = []
  commits.push(await commitAll(git, repoPath, 'chore: initial commit', 0))

  // Commit 2: sources
  await writeText(abs(rel.indexTs), "export const greeting = 'hello'\n")
  await writeText(
    abs(rel.packageJson),
    `${JSON.stringify({ name, version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`,
  )
  await writeText(abs(rel.utilTs), 'export const add = (a: number, b: number): number => a + b\n')
  commits.push(await commitAll(git, repoPath, 'feat: add sources', 1))

  // Commit 3: binary asset (or docs when binaries are disabled)
  if (withBinary) {
    rel.logo = 'assets/logo.png'
    await fs.mkdir(abs('assets'), { recursive: true })
    await fs.writeFile(abs(rel.logo), fixtureBinary(0xc0ffee))
    commits.push(await commitAll(git, repoPath, 'feat: add logo', 2))
  } else {
    await writeText(abs(rel.readme), '# demo\n\nA fixture project.\n\nSee CONTRIBUTING.\n')
    commits.push(await commitAll(git, repoPath, 'docs: expand readme', 2))
  }

  // Hostile file names (opt-in). Committed and ignored entries get their own commit so the default
  // fixture's status/count assertions elsewhere are untouched when the option is not used.
  const hostilePaths = {
    committed: [] as string[],
    untracked: [] as string[],
    ignored: [] as string[],
  }
  if (opts.hostileNames) {
    throwIfAborted(opts.signal)
    hostilePaths.committed = [...(opts.hostileNames.committed ?? [])]
    hostilePaths.ignored = [...(opts.hostileNames.ignored ?? [])]
    for (const name of hostilePaths.ignored) {
      if (name.includes('\n')) {
        throw new MigrationError(
          'INVALID_INPUT',
          `Ignored fixture name may not contain a newline: ${JSON.stringify(name)}`,
        )
      }
    }
    for (const name of [...hostilePaths.committed, ...hostilePaths.ignored]) {
      await writeText(path.join(repoPath, ...name.split('/')), `content of ${name}\n`)
    }
    if (hostilePaths.ignored.length > 0) {
      await writeText(
        abs(rel.gitignore),
        `${FIXTURE_GITIGNORE_LINES.join('\n')}\n${hostilePaths.ignored.map((n) => `/${n}`).join('\n')}\n`,
      )
    }
    if (hostilePaths.committed.length > 0) {
      // `--` first: the names are data, never options.
      await git(['add', '--', ...hostilePaths.committed], repoPath)
    }
    // Only when there is something to record: `git commit` on a clean tree exits 1, and an
    // untracked-only request leaves the tree clean.
    if (hostilePaths.committed.length > 0 || hostilePaths.ignored.length > 0) {
      commits.push(await commitAll(git, repoPath, 'test: files with hostile names', commits.length))
    }
  }

  // Feature branch with one extra commit, then back to main.
  throwIfAborted(opts.signal)
  assertSafeBranchName(FIXTURE_FEATURE_BRANCH)
  await git(['checkout', '--quiet', '-b', FIXTURE_FEATURE_BRANCH], repoPath)
  await writeText(abs(rel.onboardingTs), 'export const onboarding = { steps: 3 }\n')
  const featureHead = await commitAll(git, repoPath, 'feat: onboarding flow', 3)
  await git(['checkout', '--quiet', FIXTURE_PRIMARY_BRANCH, '--'], repoPath)

  // Remote (metadata only) + simulated remote-tracking ref so `--all` bundles look realistic.
  await git(['remote', 'add', '--', 'origin', remoteUrl], repoPath)
  await git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main'], repoPath)
  await git(['config', 'branch.main.remote', 'origin'], repoPath)
  await git(['config', 'branch.main.merge', 'refs/heads/main'], repoPath)

  // Linked worktree as a sibling directory.
  const worktreePath = path.join(root, `${name}${FIXTURE_WORKTREE_SUFFIX}`)
  if (withWorktree) {
    throwIfAborted(opts.signal)
    await git(['worktree', 'add', '--quiet', '--', worktreePath, FIXTURE_FEATURE_BRANCH], repoPath)
  }

  if (withLocalChanges) {
    throwIfAborted(opts.signal)
    // staged modification + staged new file
    await writeText(abs(rel.indexTs), "export const greeting = 'hello, world'\n")
    rel.newStaged = 'src/new-staged.ts'
    await writeText(abs(rel.newStaged), 'export const staged = true\n')
    await git(['add', '--', rel.indexTs, rel.newStaged], repoPath)
    // unstaged modification
    await writeText(abs(rel.readme), '# demo\n\nA fixture project.\n\nLocal, uncommitted note.\n')
    // unstaged binary modification
    if (withBinary && rel.logo) await fs.writeFile(abs(rel.logo), fixtureBinary(0xbadf00d))
    // untracked file in a new directory
    rel.todo = 'notes/todo.md'
    await writeText(abs(rel.todo), '- [ ] write tests\n')
    // ignored files
    if (withIgnoredEnv) {
      rel.envLocal = '.env.local'
      await writeText(
        abs(rel.envLocal),
        `API_KEY=${FIXTURE_ENV_SECRETS.API_KEY}\nDATABASE_URL=${FIXTURE_ENV_SECRETS.DATABASE_URL}\n`,
      )
    }
    rel.nodeModulesJunk = 'node_modules/junk.js'
    await writeText(abs(rel.nodeModulesJunk), 'module.exports = {}\n')
  }

  if (opts.hostileNames?.untracked && opts.hostileNames.untracked.length > 0) {
    throwIfAborted(opts.signal)
    hostilePaths.untracked = [...opts.hostileNames.untracked]
    for (const name of hostilePaths.untracked) {
      await writeText(path.join(repoPath, ...name.split('/')), `content of ${name}\n`)
    }
  }

  let worktree: GitWorktreeFixture | undefined
  if (withWorktree) {
    const wtFiles: GitWorktreeFixture['files'] = {}
    if (withLocalChanges) {
      wtFiles.modified = path.join(worktreePath, ...rel.onboardingTs.split('/'))
      await writeText(wtFiles.modified, 'export const onboarding = { steps: 4 }\n')
      wtFiles.untracked = path.join(worktreePath, 'notes', 'wt-scratch.md')
      await writeText(wtFiles.untracked, 'worktree scratch\n')
    }
    worktree = {
      path: worktreePath,
      branch: FIXTURE_FEATURE_BRANCH,
      head: featureHead,
      relativeToPrimary: relativeWorktreeShape(repoPath, worktreePath),
      files: wtFiles,
      expected: await captureGitState(worktreePath, baseExec, { env, ...signalOpts }),
    }
  }

  const head = (await git(['rev-parse', 'HEAD'], repoPath)).stdout.trim()
  const expected = await captureGitState(repoPath, baseExec, { env, ...signalOpts })

  const fixture: GitRepoFixture = {
    path: repoPath,
    name,
    primaryBranch: FIXTURE_PRIMARY_BRANCH,
    head,
    commits,
    featureBranch: FIXTURE_FEATURE_BRANCH,
    featureHead,
    remoteName: 'origin',
    remoteUrl,
    files: absoluteFiles(repoPath, rel),
    relativePaths: rel,
    env,
    exec,
    expected,
    secrets: withIgnoredEnv && withLocalChanges ? Object.values(FIXTURE_ENV_SECRETS) : [],
    hostilePaths,
  }
  if (worktree) fixture.worktree = worktree
  return fixture
}

/**
 * Re-captures `expected` (primary checkout and linked worktree) after the caller changed the
 * working tree, e.g. after dropping extra untracked files into the project. Mutates and returns the fixture.
 */
export async function refreshGitFixtureExpectations(
  fixture: GitRepoFixture,
  opts: { exec?: Exec; signal?: AbortSignal } = {},
): Promise<GitRepoFixture> {
  const exec = opts.exec ?? realExec
  const signalOpts = opts.signal ? { signal: opts.signal } : {}
  fixture.expected = await captureGitState(fixture.path, exec, { env: fixture.env, ...signalOpts })
  if (fixture.worktree) {
    fixture.worktree.expected = await captureGitState(fixture.worktree.path, exec, {
      env: fixture.env,
      ...signalOpts,
    })
  }
  return fixture
}

export interface SimpleRepoOptions {
  root: string
  name: string
  homeDir?: string
  exec?: Exec
  signal?: AbortSignal
}

export interface SimpleRepoFixture {
  path: string
  /** Commits oldest first (empty for createEmptyRepo). */
  commits: string[]
  head: string | null
  env: Record<string, string>
  exec: Exec
  expected: GitStateSnapshot
}

function simpleRepoSetup(opts: SimpleRepoOptions): {
  repoPath: string
  env: Record<string, string>
  baseExec: Exec
  git: GitRunner
} {
  const root = assertSafeFixtureRoot(opts.root)
  const name = assertRepoName(opts.name)
  const baseExec = opts.exec ?? realExec
  const env = gitTestEnv(opts.homeDir === undefined ? root : assertSafeFixtureRoot(opts.homeDir))
  const git = createGitRunner(baseExec, env, opts.signal ? { signal: opts.signal } : {})
  return { repoPath: path.join(root, name), env, baseExec, git }
}

/** Repo with two commits whose HEAD is detached at the first commit. */
export async function createDetachedHeadRepo(opts: SimpleRepoOptions): Promise<SimpleRepoFixture> {
  const { repoPath, env, baseExec, git } = simpleRepoSetup(opts)
  await initRepo(git, repoPath)
  await writeText(path.join(repoPath, 'README.md'), '# detached\n')
  const first = await commitAll(git, repoPath, 'first', 0)
  await writeText(path.join(repoPath, 'second.txt'), 'second\n')
  const second = await commitAll(git, repoPath, 'second', 1)
  await git(['checkout', '--quiet', '--detach', first, '--'], repoPath)
  const expected = await captureGitState(repoPath, baseExec, { env })
  return {
    path: repoPath,
    commits: [first, second],
    head: first,
    env,
    exec: bindExecEnv(baseExec, env),
    expected,
  }
}

/** `git init` only: no commits, unborn main branch. */
export async function createEmptyRepo(opts: SimpleRepoOptions): Promise<SimpleRepoFixture> {
  const { repoPath, env, baseExec, git } = simpleRepoSetup(opts)
  await initRepo(git, repoPath)
  const expected = await captureGitState(repoPath, baseExec, { env })
  return {
    path: repoPath,
    commits: [],
    head: null,
    env,
    exec: bindExecEnv(baseExec, env),
    expected,
  }
}
