import { describe, expect, it } from 'vitest'
import { MigrationError } from '@devmig/shared'
import { createFakeExec, matchCommand } from '@devmig/test-utils'
import {
  assertSafeArg,
  assertSafeBranchName,
  assertSha,
  checkGitAvailable,
  checkRefFormat,
  countStashEntries,
  createGitClient,
  gitEnvironment,
  isGitVersionAtLeast,
  isSafeFullRef,
  isSafeRemoteUrl,
  isValidBranchName,
  isValidRemoteName,
  parseCountObjects,
  parseGitVersion,
  parseRemotes,
  parseStatusV2Lines,
  parseStatusV2Z,
  parseUpstreams,
  parseWorktreeList,
  quoteCPath,
  relativeToPrimaryFor,
  statusEntryPath,
  unquoteCPath,
} from './git'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const NUL = String.fromCharCode(0)
const TAB = String.fromCharCode(9)
const BEL = String.fromCharCode(7)
const DEL = String.fromCharCode(127)
const ESC = String.fromCharCode(27)

describe('parseStatusV2Z', () => {
  it('parses changed, renamed (with original path), unmerged, untracked, ignored and header records', () => {
    const text = [
      '# branch.oid 1234',
      `1 M. N... 100644 100644 100644 ${SHA_A} ${SHA_B} src/index.ts`,
      `1 .M N... 100644 100644 100644 ${SHA_A} ${SHA_A} README with space.md`,
      `2 R. N... 100644 100644 100644 ${SHA_A} ${SHA_A} R100 new name.md`,
      'old name.md',
      `u UU N... 100644 100644 100644 100644 ${SHA_A} ${SHA_B} ${SHA_A} conflict.txt`,
      '? notes/todo.md',
      '! node_modules/',
      'weird record',
    ].join(NUL)
    const entries = parseStatusV2Z(`${text}${NUL}`)
    expect(entries.map((e) => e.kind)).toEqual([
      'header',
      'changed',
      'changed',
      'renamed',
      'unmerged',
      'untracked',
      'ignored',
      'unknown',
    ])
    expect(entries[1]).toMatchObject({
      kind: 'changed',
      xy: 'M.',
      staged: true,
      unstaged: false,
      path: 'src/index.ts',
      hashHead: SHA_A,
      hashIndex: SHA_B,
    })
    expect(entries[2]).toMatchObject({
      kind: 'changed',
      xy: '.M',
      staged: false,
      unstaged: true,
      path: 'README with space.md',
    })
    expect(entries[3]).toMatchObject({
      kind: 'renamed',
      score: 'R100',
      path: 'new name.md',
      originalPath: 'old name.md',
      staged: true,
    })
    expect(entries[4]).toMatchObject({
      kind: 'unmerged',
      xy: 'UU',
      path: 'conflict.txt',
      hashStage2: SHA_B,
    })
    expect(entries[5]).toEqual({ kind: 'untracked', path: 'notes/todo.md' })
    expect(entries[6]).toEqual({ kind: 'ignored', path: 'node_modules/' })
    expect(entries[7]).toEqual({ kind: 'unknown', line: 'weird record' })
    expect(entries.map(statusEntryPath)).toEqual([
      null,
      'src/index.ts',
      'README with space.md',
      'new name.md',
      'conflict.txt',
      'notes/todo.md',
      'node_modules/',
      null,
    ])
  })

  it('returns an empty list for empty output', () => {
    expect(parseStatusV2Z('')).toEqual([])
  })
})

describe('parseStatusV2Lines', () => {
  it('splits rename lines on TAB and unquotes C-quoted paths', () => {
    const lines = [
      `2 RM N... 100644 100644 100644 ${SHA_A} ${SHA_A} R100 READ ME.md${TAB}README.md`,
      '? "tab\\there.txt"',
      '? "uml\\303\\244ut.txt"',
      '1 .M N... 100644 100644 100644 abc def plain.txt',
      '',
    ]
    const entries = parseStatusV2Lines(lines)
    expect(entries[0]).toMatchObject({
      kind: 'renamed',
      xy: 'RM',
      path: 'READ ME.md',
      originalPath: 'README.md',
      staged: true,
      unstaged: true,
    })
    expect(entries[1]).toEqual({ kind: 'untracked', path: `tab${TAB}here.txt` })
    expect(entries[2]).toEqual({ kind: 'untracked', path: 'umläut.txt' })
    expect(entries[3]).toMatchObject({ kind: 'changed', path: 'plain.txt' })
    expect(entries).toHaveLength(4)
  })
})

describe('C-style path quoting', () => {
  it('round-trips control characters, quotes and backslashes', () => {
    for (const p of [
      'plain.txt',
      `tab${TAB}here`,
      'quote"x',
      'back\\slash',
      `bell${BEL}`,
      `del${DEL}`,
      'umläut',
    ]) {
      expect(unquoteCPath(quoteCPath(p))).toBe(p)
    }
    expect(quoteCPath('plain.txt')).toBe('plain.txt')
    expect(quoteCPath('umläut')).toBe('umläut')
    expect(quoteCPath(`tab${TAB}here`)).toBe('"tab\\there"')
    expect(quoteCPath(`bell${BEL}`)).toBe('"bell\\a"')
    expect(quoteCPath(`esc${ESC}`)).toBe('"esc\\033"')
  })
})

describe('parseWorktreeList', () => {
  it('parses primary, detached, locked, prunable, bare and unborn entries', () => {
    const text = [
      '/repo',
      `HEAD ${SHA_A}`,
      'branch refs/heads/main',
      '',
      'worktree /repo',
      `HEAD ${SHA_A}`,
      'branch refs/heads/main',
      '',
      'worktree /repo-feature',
      `HEAD ${SHA_B}`,
      'branch refs/heads/feature/onboarding',
      'locked working on it',
      '',
      'worktree /repo-detached',
      `HEAD ${SHA_B}`,
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /bare.git',
      'bare',
      '',
      'worktree /repo-unborn',
      `HEAD ${'0'.repeat(40)}`,
      'branch refs/heads/new',
      '',
    ].join('\n')
    const entries = parseWorktreeList(text)
    expect(entries).toHaveLength(5)
    expect(entries[0]).toMatchObject({
      path: '/repo',
      head: SHA_A,
      branch: 'main',
      detached: false,
      locked: false,
      prunable: false,
    })
    expect(entries[1]).toMatchObject({
      path: '/repo-feature',
      branch: 'feature/onboarding',
      locked: true,
      lockReason: 'working on it',
    })
    expect(entries[2]).toMatchObject({
      path: '/repo-detached',
      branch: null,
      detached: true,
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    })
    expect(entries[3]).toMatchObject({ path: '/bare.git', bare: true, head: null })
    expect(entries[4]).toMatchObject({ path: '/repo-unborn', head: null, branch: 'new' })
  })
})

describe('parseRemotes', () => {
  it('merges fetch and push lines and keeps push URLs only when they differ', () => {
    const text = [
      `origin${TAB}https://github.com/example/demo.git (fetch)`,
      `origin${TAB}https://github.com/example/demo.git (push)`,
      `fork${TAB}git@github.com:me/demo.git (fetch)`,
      `fork${TAB}git@github.com:me/demo-push.git (push)`,
      `pushonly${TAB}ssh://host/x (push)`,
    ].join('\n')
    expect(parseRemotes(text)).toEqual([
      { name: 'origin', fetchUrl: 'https://github.com/example/demo.git' },
      {
        name: 'fork',
        fetchUrl: 'git@github.com:me/demo.git',
        pushUrl: 'git@github.com:me/demo-push.git',
      },
      { name: 'pushonly', fetchUrl: 'ssh://host/x' },
    ])
  })
})

describe('parseCountObjects / parseUpstreams / countStashEntries', () => {
  it('converts KiB sizes to bytes', () => {
    const counts = parseCountObjects(
      'count: 3\nsize: 12\nin-pack: 7\npacks: 1\nsize-pack: 1024\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0\n',
    )
    expect(counts).toEqual({
      looseObjects: 3,
      looseBytes: 12 * 1024,
      packedObjects: 7,
      packBytes: 1024 * 1024,
      totalBytes: (12 + 1024) * 1024,
    })
  })
  it('parses branch upstream configuration including dotted branch names', () => {
    const text =
      'branch.main.remote origin\nbranch.main.merge refs/heads/main\nbranch.release/v1.2.remote upstream\nbranch.release/v1.2.merge refs/heads/release/v1.2\n'
    expect(parseUpstreams(text)).toEqual({
      main: { remote: 'origin', merge: 'refs/heads/main' },
      'release/v1.2': { remote: 'upstream', merge: 'refs/heads/release/v1.2' },
    })
  })
  it('counts stash entries', () => {
    expect(countStashEntries('')).toBe(0)
    expect(countStashEntries('stash@{0}: WIP on main: 1234 x\nstash@{1}: On feature: y\n')).toBe(2)
  })
})

describe('parseGitVersion', () => {
  it('parses Apple and plain version strings', () => {
    expect(parseGitVersion('git version 2.50.1 (Apple Git-155)\n')).toMatchObject({
      major: 2,
      minor: 50,
      patch: 1,
    })
    expect(parseGitVersion('git version 2.39')).toMatchObject({ major: 2, minor: 39, patch: 0 })
    expect(parseGitVersion('not git')).toBeUndefined()
    const v = parseGitVersion('git version 2.19.2')
    expect(v && isGitVersionAtLeast(v, 2, 20)).toBe(false)
    const w = parseGitVersion('git version 3.0.0')
    expect(w && isGitVersionAtLeast(w, 2, 20)).toBe(true)
  })
})

describe('argument validation', () => {
  it('assertSafeArg rejects empty, control characters and leading dashes', () => {
    expect(assertSafeArg('ok', 'x')).toBe('ok')
    expect(() => assertSafeArg('', 'x')).toThrow(MigrationError)
    expect(() => assertSafeArg('-evil', 'x')).toThrow(/must not start with '-'/)
    expect(() => assertSafeArg('a\nb', 'x')).toThrow(/control characters/)
  })

  it('branch names follow check-ref-format rules and never start with a dash', () => {
    for (const ok of ['main', 'feature/onboarding', 'release/v1.2', 'user@host', 'a.b']) {
      expect(isValidBranchName(ok), ok).toBe(true)
      expect(assertSafeBranchName(ok)).toBe(ok)
    }
    for (const bad of [
      '-evil',
      'a..b',
      'HEAD',
      'a.lock',
      'x/.hidden',
      'a b',
      'a~b',
      'a^b',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a\\b',
      '/lead',
      'trail/',
      'trail.',
      'a//b',
      'a@{b',
      '@',
      '',
      `ctl${TAB}x`,
    ]) {
      expect(isValidBranchName(bad), JSON.stringify(bad)).toBe(false)
      expect(() => assertSafeBranchName(bad)).toThrow(MigrationError)
    }
    try {
      assertSafeBranchName('-evil')
    } catch (err) {
      expect((err as MigrationError).code).toBe('GIT_INVALID_REF')
    }
  })

  it('validates shas, remote names, URLs and full refs', () => {
    expect(assertSha(SHA_A)).toBe(SHA_A)
    expect(assertSha('c'.repeat(64))).toBe('c'.repeat(64))
    expect(() => assertSha('abc')).toThrow(MigrationError)
    expect(() => assertSha('-' + 'a'.repeat(39))).toThrow(MigrationError)
    expect(isValidRemoteName('origin')).toBe(true)
    expect(isValidRemoteName('my-fork.2')).toBe(true)
    expect(isValidRemoteName('-x')).toBe(false)
    expect(isValidRemoteName('a..b')).toBe(false)
    expect(isValidRemoteName('with space')).toBe(false)
    expect(isSafeRemoteUrl('https://github.com/example/demo.git')).toBe(true)
    expect(isSafeRemoteUrl('git@github.com:me/x.git')).toBe(true)
    expect(isSafeRemoteUrl('ext::sh -c evil')).toBe(false)
    expect(isSafeRemoteUrl('fd::17')).toBe(false)
    expect(isSafeRemoteUrl('-oProxyCommand=evil')).toBe(false)
    expect(isSafeRemoteUrl('bad\nurl')).toBe(false)
    expect(isSafeFullRef('refs/heads/main')).toBe(true)
    expect(isSafeFullRef('refs/heads/feature/x')).toBe(true)
    expect(isSafeFullRef('heads/main')).toBe(false)
    expect(isSafeFullRef('refs/heads/a..b')).toBe(false)
    expect(isSafeFullRef('refs/heads/x.lock')).toBe(false)
  })

  it('relativeToPrimaryFor accepts children and siblings only', () => {
    expect(relativeToPrimaryFor('/a/demo', '/a/demo-onboarding')).toBe('../demo-onboarding')
    expect(relativeToPrimaryFor('/a/demo', '/a/demo/.claude/worktrees/x')).toBe(
      '.claude/worktrees/x',
    )
    expect(relativeToPrimaryFor('/a/demo', '/elsewhere/x')).toBeUndefined()
    expect(relativeToPrimaryFor('/a/demo', '/a/demo')).toBeUndefined()
  })
})

describe('git client', () => {
  it('strips redirecting environment variables and disables prompts/locks', () => {
    const env = gitEnvironment(
      { HOME: '/h', GIT_DIR: '/evil', GIT_WORK_TREE: '/evil', PATH: '/bin' },
      true,
    )
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env).toMatchObject({
      HOME: '/h',
      PATH: '/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    })
    expect(gitEnvironment({}, false).GIT_OPTIONAL_LOCKS).toBeUndefined()
  })

  it('passes argument arrays through the injected Exec with cwd and env', async () => {
    const fake = createFakeExec([{ match: matchCommand('git', 'status'), result: { stdout: '' } }])
    const git = createGitClient(fake.exec, { env: { HOME: '/h' } })
    await git.run(['status', '--porcelain=v2'], { cwd: '/repo' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ file: 'git', args: ['status', '--porcelain=v2'] })
    expect(fake.calls[0]?.options).toMatchObject({
      cwd: '/repo',
      env: { HOME: '/h', GIT_TERMINAL_PROMPT: '0' },
    })
  })

  it('refuses NUL bytes in arguments', () => {
    const fake = createFakeExec([])
    const git = createGitClient(fake.exec, { env: {} })
    expect(() => git.run(['log', `a${NUL}b`], { cwd: '/repo' })).toThrow(MigrationError)
    expect(fake.calls).toHaveLength(0)
  })

  it('checkGitAvailable reports a missing binary without throwing', async () => {
    const missing = createFakeExec([
      {
        match: matchCommand('git', '--version'),
        result: () => {
          throw new MigrationError('PATH_NOT_FOUND', 'Executable not found: git')
        },
      },
    ])
    expect(await checkGitAvailable(missing.exec, {})).toMatchObject({ available: false })
    const present = createFakeExec([
      { match: matchCommand('git', '--version'), result: { stdout: 'git version 2.44.0\n' } },
    ])
    expect(await checkGitAvailable(present.exec, {})).toMatchObject({
      available: true,
      version: { major: 2, minor: 44 },
    })
  })

  it('checkRefFormat rejects dash-prefixed and malformed names before invoking git', async () => {
    const fake = createFakeExec([
      { match: matchCommand('git', 'check-ref-format'), result: { stdout: '' } },
    ])
    const git = createGitClient(fake.exec, { env: {} })
    expect(await checkRefFormat(git, '/tmp', '-evil')).toBe(false)
    expect(await checkRefFormat(git, '/tmp', 'a..b')).toBe(false)
    expect(fake.calls).toHaveLength(0)
    expect(await checkRefFormat(git, '/tmp', 'feature/x')).toBe(true)
    expect(fake.calls[0]?.args).toEqual(['check-ref-format', '--branch', 'feature/x'])
  })
})
