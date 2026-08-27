import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '@devmig/shared'
import {
  FIXTURE_ENV_SECRETS,
  createDetachedHeadRepo,
  createEmptyRepo,
  createGitRepoFixture,
  refreshGitFixtureExpectations,
  type GitRepoFixture,
} from './git-fixture'
import { parseStatusV2 } from './git-parsers'
import { captureGitState, compareGitState } from './git-state'
import { makeTempRoot, type TempRoot } from './temp'

let tmp: TempRoot
let fixture: GitRepoFixture

beforeAll(async () => {
  tmp = await makeTempRoot('devmig-git-fixture-')
  fixture = await createGitRepoFixture({ root: tmp.root, name: 'demo' })
})

afterAll(async () => {
  await tmp.cleanup()
})

function statusPaths(lines: readonly string[], predicate: (xy: string) => boolean): string[] {
  return parseStatusV2(lines)
    .flatMap((e) => (e.kind === 'changed' && predicate(e.xy) ? [e.path] : []))
    .sort()
}

describe('createGitRepoFixture', () => {
  it('creates 3 commits on main, a feature branch, a remote and a clean history', async () => {
    expect(fixture.path).toBe(path.join(tmp.root, 'demo'))
    expect(fixture.primaryBranch).toBe('main')
    expect(fixture.commits).toHaveLength(3)
    expect(fixture.head).toBe(fixture.commits[2])
    expect(fixture.featureBranch).toBe('feature/onboarding')
    expect(fixture.featureHead).not.toBe(fixture.head)
    const log = await fixture.exec('git', ['log', '--format=%H', 'main'], { cwd: fixture.path })
    expect(log.stdout.trim().split('\n').reverse()).toEqual(fixture.commits)
    const remote = await fixture.exec('git', ['remote', 'get-url', 'origin'], { cwd: fixture.path })
    expect(remote.stdout.trim()).toBe('https://github.com/example/demo.git')
    expect(fixture.remoteUrl).toBe('https://github.com/example/demo.git')
    const featureParent = await fixture.exec('git', ['rev-parse', 'feature/onboarding^'], {
      cwd: fixture.path,
    })
    expect(featureParent.stdout.trim()).toBe(fixture.head)
    expect(fixture.relativePaths.gitignore).toBe('.gitignore')
    const gitignore = await fs.readFile(fixture.files.gitignore, 'utf8')
    expect(gitignore).toContain('.env*\n')
    expect(gitignore).toContain('node_modules/\n')
  })

  it('produces the expected staged / unstaged / untracked / binary status lines', () => {
    const lines = fixture.expected.statusV2
    expect(statusPaths(lines, (xy) => xy === 'M.')).toEqual(['src/index.ts'])
    expect(statusPaths(lines, (xy) => xy === 'A.')).toEqual(['src/new-staged.ts'])
    expect(statusPaths(lines, (xy) => xy === '.M')).toEqual(['README.md', 'assets/logo.png'])
    expect(
      parseStatusV2(lines)
        .filter((e) => e.kind === 'untracked')
        .map((e) => e.path),
    ).toEqual(['notes/todo.md'])
    expect(fixture.expected.untracked).toEqual(['notes/todo.md'])
    expect(lines).toEqual([...lines].sort())
    expect(fixture.expected.head).toBe(fixture.head)
    expect(fixture.expected.branch).toBe('main')
    expect(fixture.expected.detached).toBe(false)
  })

  it('captures binary-safe diffs with full index', () => {
    expect(fixture.expected.stagedDiff).toContain('diff --git a/src/index.ts b/src/index.ts')
    expect(fixture.expected.stagedDiff).toContain(
      'diff --git a/src/new-staged.ts b/src/new-staged.ts',
    )
    expect(fixture.expected.stagedDiff).toContain('new file mode 100644')
    expect(fixture.expected.unstagedDiff).toContain('diff --git a/README.md b/README.md')
    expect(fixture.expected.unstagedDiff).toContain(
      'diff --git a/assets/logo.png b/assets/logo.png',
    )
    expect(fixture.expected.unstagedDiff).toContain('GIT binary patch')
    // --full-index: 40-hex blob ids in the index line
    expect(fixture.expected.unstagedDiff).toMatch(/index [0-9a-f]{40}\.\.[0-9a-f]{40}/)
  })

  it('keeps ignored files (.env.local, node_modules) out of the untracked list but on disk', async () => {
    expect(fixture.files.envLocal).toBeDefined()
    expect(fixture.files.nodeModulesJunk).toBeDefined()
    if (!fixture.files.envLocal || !fixture.files.nodeModulesJunk) return
    const env = await fs.readFile(fixture.files.envLocal, 'utf8')
    expect(env).toContain(`API_KEY=${FIXTURE_ENV_SECRETS.API_KEY}`)
    expect(env).toContain(`DATABASE_URL=${FIXTURE_ENV_SECRETS.DATABASE_URL}`)
    expect(fixture.secrets).toEqual([FIXTURE_ENV_SECRETS.API_KEY, FIXTURE_ENV_SECRETS.DATABASE_URL])
    expect(fixture.expected.untracked).not.toContain('.env.local')
    expect(fixture.expected.untracked).not.toContain('node_modules/junk.js')
    expect(fixture.expected.statusV2.join('\n')).not.toContain('.env.local')
    const ignored = await fixture.exec(
      'git',
      ['status', '--porcelain=v2', '--ignored', '--untracked-files=all'],
      {
        cwd: fixture.path,
      },
    )
    expect(ignored.stdout).toContain('! .env.local')
    expect(ignored.stdout).toContain('! node_modules/junk.js')
  })

  it('registers a sibling worktree on feature/onboarding with its own dirty state', async () => {
    const wt = fixture.worktree
    expect(wt).toBeDefined()
    if (!wt) return
    expect(wt.path).toBe(path.join(tmp.root, 'demo-onboarding'))
    expect(wt.branch).toBe('feature/onboarding')
    expect(wt.head).toBe(fixture.featureHead)
    expect(wt.relativeToPrimary).toBe('../demo-onboarding')
    expect(
      fixture.expected.worktrees.map((w) => ({ path: w.path, branch: w.branch, head: w.head })),
    ).toEqual([
      { path: fixture.path, branch: 'main', head: fixture.head },
      { path: wt.path, branch: 'feature/onboarding', head: fixture.featureHead },
    ])
    expect(wt.expected.branch).toBe('feature/onboarding')
    expect(wt.expected.head).toBe(fixture.featureHead)
    expect(statusPaths(wt.expected.statusV2, (xy) => xy === '.M')).toEqual(['src/onboarding.ts'])
    expect(wt.expected.untracked).toEqual(['notes/wt-scratch.md'])
    expect(await fs.readFile(path.join(wt.path, 'src', 'onboarding.ts'), 'utf8')).toContain(
      'steps: 4',
    )
    // The worktree shares the primary's object store.
    const common = await fixture.exec('git', ['rev-parse', '--git-common-dir'], { cwd: wt.path })
    expect(path.resolve(wt.path, common.stdout.trim())).toBe(path.join(fixture.path, '.git'))
  })

  it('never touches global git config and uses a per-repo identity', async () => {
    expect(fixture.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(fixture.env.HOME).toBe(tmp.root)
    const name = await fixture.exec('git', ['config', '--local', 'user.name'], {
      cwd: fixture.path,
    })
    expect(name.stdout.trim()).toBe('Fixture User')
    const author = await fixture.exec('git', ['log', '-1', '--format=%an <%ae>'], {
      cwd: fixture.path,
    })
    expect(author.stdout.trim()).toBe('Fixture User <fixture@example.com>')
    await expect(fs.stat(path.join(tmp.root, '.gitconfig'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses to build on top of an existing directory and validates names/urls', async () => {
    await expect(createGitRepoFixture({ root: tmp.root, name: 'demo' })).rejects.toThrow(
      /already exists/,
    )
    await expect(createGitRepoFixture({ root: tmp.root, name: '../x' })).rejects.toThrow()
    await expect(
      createGitRepoFixture({ root: tmp.root, name: 'bad', remoteUrl: '-oops' }),
    ).rejects.toThrow()
    await expect(
      createGitRepoFixture({ root: tmp.root, name: 'bad', remoteUrl: 'ext::sh -c evil' }),
    ).rejects.toThrow()
  })

  it('supports disabling the worktree, binary, env and local changes', async () => {
    const clean = await createGitRepoFixture({
      root: tmp.root,
      name: 'clean',
      withWorktree: false,
      withLocalChanges: false,
      withBinary: false,
      withIgnoredEnv: false,
    })
    expect(clean.worktree).toBeUndefined()
    expect(clean.files.logo).toBeUndefined()
    expect(clean.files.envLocal).toBeUndefined()
    expect(clean.secrets).toEqual([])
    expect(clean.expected.statusV2).toEqual([])
    expect(clean.expected.untracked).toEqual([])
    expect(clean.expected.stagedDiff).toBe('')
    expect(clean.expected.unstagedDiff).toBe('')
    expect(clean.expected.worktrees).toHaveLength(1)
    expect(clean.commits).toHaveLength(3)
  })
})

describe('captureGitState / compareGitState', () => {
  it('is equal to a fresh capture of the same checkout and to itself', async () => {
    const again = await captureGitState(fixture.path, realExec, { env: fixture.env })
    expect(compareGitState(fixture.expected, fixture.expected)).toEqual({
      equal: true,
      differences: [],
    })
    expect(compareGitState(fixture.expected, again)).toEqual({ equal: true, differences: [] })
  })

  it('reports differences after a change and equality again after refreshing expectations', async () => {
    const extra = path.join(fixture.path, 'notes', 'extra.md')
    await fs.writeFile(extra, 'extra\n')
    try {
      const changed = await captureGitState(fixture.path, realExec, { env: fixture.env })
      const cmp = compareGitState(fixture.expected, changed)
      expect(cmp.equal).toBe(false)
      expect(cmp.differences).toEqual(
        expect.arrayContaining([
          'untracked: only in second: notes/extra.md',
          'statusV2: only in second: ? notes/extra.md',
        ]),
      )
      expect(
        compareGitState(fixture.expected, changed, { ignorePaths: ['notes/extra.md'] }).equal,
      ).toBe(true)
      await refreshGitFixtureExpectations(fixture)
      expect(compareGitState(fixture.expected, changed).equal).toBe(true)
    } finally {
      await fs.rm(extra, { force: true })
      await refreshGitFixtureExpectations(fixture)
    }
  })

  it('compares worktrees by relative shape, so a relocated clone with the same layout is equal', async () => {
    const otherRoot = path.join(tmp.root, 'elsewhere')
    await fs.mkdir(otherRoot)
    const twin = await createGitRepoFixture({ root: otherRoot, name: 'demo' })
    expect(twin.path).not.toBe(fixture.path)
    expect(compareGitState(fixture.expected, twin.expected)).toEqual({
      equal: true,
      differences: [],
    })
    expect(twin.head).toBe(fixture.head) // deterministic commit dates + identity => identical shas
  })

  it('honours cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      captureGitState(fixture.path, realExec, { env: fixture.env, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})

describe('edge-case repositories', () => {
  it('createDetachedHeadRepo reports detached HEAD with a null branch', async () => {
    const repo = await createDetachedHeadRepo({ root: tmp.root, name: 'detached' })
    expect(repo.commits).toHaveLength(2)
    expect(repo.head).toBe(repo.commits[0])
    expect(repo.expected).toMatchObject({ head: repo.commits[0], branch: null, detached: true })
    expect(repo.expected.worktrees[0]).toMatchObject({
      detached: true,
      branch: null,
      head: repo.commits[0],
    })
    expect(repo.expected.statusV2).toEqual([])
  })

  it('createEmptyRepo reports an unborn branch', async () => {
    const repo = await createEmptyRepo({ root: tmp.root, name: 'empty' })
    expect(repo.commits).toEqual([])
    expect(repo.head).toBeNull()
    expect(repo.expected).toMatchObject({
      head: null,
      branch: 'main',
      detached: false,
      statusV2: [],
      untracked: [],
    })
    expect(repo.expected.worktrees[0]).toMatchObject({ head: null, branch: 'main' })
  })
})
