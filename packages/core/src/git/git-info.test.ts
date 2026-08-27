import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeExec } from '../testing/fake-exec'
import { collectingLogger } from '../testing/engine-fixtures'
import {
  parseRemotes,
  parseWorktreeListPorcelain,
  readProjectGitInfo,
  relativeToPrimaryFor,
} from './git-info'

describe('parseWorktreeListPorcelain', () => {
  it('parses primary, linked, detached, locked, prunable and bare entries', () => {
    const text = [
      'worktree /Users/me/proj',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/proj-feature',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/x',
      'locked reason with spaces',
      '',
      'worktree /Users/me/proj/.claude/worktrees/agent',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /Users/me/bare.git',
      'bare',
      '',
    ].join('\n')
    const parsed = parseWorktreeListPorcelain(text)
    expect(parsed).toHaveLength(4)
    expect(parsed[0]).toMatchObject({
      path: '/Users/me/proj',
      head: '1111111111111111111111111111111111111111',
      branch: 'main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    })
    expect(parsed[1]).toMatchObject({
      path: '/Users/me/proj-feature',
      branch: 'feature/x',
      locked: true,
      lockedReason: 'reason with spaces',
    })
    expect(parsed[2]).toMatchObject({
      path: '/Users/me/proj/.claude/worktrees/agent',
      branch: null,
      detached: true,
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    })
    expect(parsed[3]).toMatchObject({ path: '/Users/me/bare.git', bare: true, head: null })
  })

  it('treats the all-zero SHA of an unborn branch as no HEAD', () => {
    const parsed = parseWorktreeListPorcelain(
      'worktree /tmp/empty\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n',
    )
    expect(parsed[0]?.head).toBeNull()
    expect(parsed[0]?.branch).toBe('main')
  })

  it('handles CRLF, missing trailing blank line, and paths with spaces / unicode', () => {
    const parsed = parseWorktreeListPorcelain(
      'worktree /Users/me/My Projects/日本語\r\nHEAD abc\r\nbranch refs/heads/main',
    )
    expect(parsed).toEqual([
      {
        path: '/Users/me/My Projects/日本語',
        head: 'abc',
        branch: 'main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ])
  })

  it('returns an empty list for empty input', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([])
    expect(parseWorktreeListPorcelain('\n\n')).toEqual([])
  })
})

describe('parseRemotes', () => {
  it('merges fetch and push lines and only records a distinct push url', () => {
    const remotes = parseRemotes(
      [
        'origin\tgit@github.com:me/proj.git (fetch)',
        'origin\tgit@github.com:me/proj.git (push)',
        'upstream\thttps://github.com/org/proj.git (fetch)',
        'upstream\thttps://github.com/org/proj-push.git (push)',
        'pushonly\tssh://x/y (push)',
        'garbage line',
      ].join('\n'),
    )
    expect(remotes).toEqual([
      { name: 'origin', fetchUrl: 'git@github.com:me/proj.git' },
      {
        name: 'upstream',
        fetchUrl: 'https://github.com/org/proj.git',
        pushUrl: 'https://github.com/org/proj-push.git',
      },
      { name: 'pushonly', fetchUrl: 'ssh://x/y' },
    ])
  })
})

describe('relativeToPrimaryFor', () => {
  it('expresses sibling and child worktrees relative to the primary', () => {
    expect(relativeToPrimaryFor('/a/proj', '/a/proj-feature')).toBe('../proj-feature')
    expect(relativeToPrimaryFor('/a/proj', '/a/proj/.claude/worktrees/x')).toBe(
      path.join('.claude', 'worktrees', 'x'),
    )
  })
  it('returns undefined for the primary itself and for unrelated locations', () => {
    expect(relativeToPrimaryFor('/a/proj', '/a/proj')).toBeUndefined()
    expect(relativeToPrimaryFor('/a/proj', '/elsewhere/deep/wt')).toBeUndefined()
  })
})

describe('readProjectGitInfo (fake exec)', () => {
  const dir = '/tmp/fake-proj'

  it('returns undefined and never throws when git is not installed', async () => {
    const exec = createFakeExec(() => undefined)
    const { logger } = collectingLogger()
    await expect(readProjectGitInfo(dir, exec, { logger })).resolves.toBeUndefined()
  })

  it('returns undefined when the directory is not a working tree', async () => {
    const exec = createFakeExec(() => ({ exitCode: 128, stderr: 'fatal: not a git repository' }))
    await expect(readProjectGitInfo(dir, exec)).resolves.toBeUndefined()
  })

  it('refuses directories starting with a dash', async () => {
    const exec = createFakeExec(() => ({ stdout: '/x' }))
    await expect(readProjectGitInfo('-rf', exec)).resolves.toBeUndefined()
    expect(exec.calls).toHaveLength(0)
  })

  it('assembles remotes, HEAD, branch, worktrees and passes constant argv arrays only', async () => {
    const exec = createFakeExec((file, args) => {
      expect(file).toBe('git')
      expect(
        args.every((a) => !a.startsWith('-') || a.startsWith('--') || a === '-v' || a === '-q'),
      )
      const key = args.join(' ')
      switch (key) {
        case 'rev-parse --show-toplevel':
          return { stdout: `${dir}\n` }
        case 'rev-parse --git-common-dir':
          return { stdout: '.git\n' }
        case 'rev-parse --verify -q HEAD':
          return { stdout: 'abc123\n' }
        case 'symbolic-ref --short -q HEAD':
          return { stdout: 'main\n' }
        case 'remote -v':
          return { stdout: 'origin\tgit@x:y.git (fetch)\norigin\tgit@x:y.git (push)\n' }
        case 'worktree list --porcelain':
          return {
            stdout: `worktree ${dir}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${dir}-wt\nHEAD def456\nbranch refs/heads/wt\n\n`,
          }
        default:
          return { exitCode: 1 }
      }
    })
    const info = await readProjectGitInfo(dir, exec)
    expect(info).toBeDefined()
    expect(info?.root).toBe(dir)
    expect(info?.head).toBe('abc123')
    expect(info?.branch).toBe('main')
    expect(info?.detached).toBe(false)
    expect(info?.isLinkedWorktree).toBe(false)
    expect(info?.remotes).toEqual([{ name: 'origin', fetchUrl: 'git@x:y.git' }])
    expect(info?.commonDir).toBe(path.join(dir, '.git'))
    expect(info?.worktrees.map((w) => [w.path, w.isPrimary, w.relativeToPrimary])).toEqual([
      [dir, true, undefined],
      [`${dir}-wt`, false, '../fake-proj-wt'],
    ])
    for (const call of exec.calls) {
      expect(call.options.cwd).toBe(dir)
      expect(call.options.timeoutMs).toBeGreaterThan(0)
      expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe('0')
    }
  })

  it('reports detached HEAD and an empty repository without HEAD', async () => {
    const detached = createFakeExec((_f, args) => {
      const key = args.join(' ')
      if (key === 'rev-parse --show-toplevel') return { stdout: dir }
      if (key === 'rev-parse --verify -q HEAD') return { stdout: 'abc\n' }
      if (key === 'symbolic-ref --short -q HEAD') return { exitCode: 1 }
      return { stdout: '' }
    })
    const d = await readProjectGitInfo(dir, detached)
    expect(d).toMatchObject({ head: 'abc', branch: null, detached: true })

    const empty = createFakeExec((_f, args) => {
      const key = args.join(' ')
      if (key === 'rev-parse --show-toplevel') return { stdout: dir }
      if (key === 'rev-parse --verify -q HEAD') return { exitCode: 1 }
      if (key === 'symbolic-ref --short -q HEAD') return { stdout: 'main' }
      return { stdout: '' }
    })
    const e = await readProjectGitInfo(dir, empty)
    expect(e).toMatchObject({ head: null, branch: 'main', detached: false, worktrees: [] })
  })

  it('marks the selected directory as a linked worktree when it is not the primary', async () => {
    const wt = `${dir}-wt`
    const exec = createFakeExec((_f, args) => {
      const key = args.join(' ')
      if (key === 'rev-parse --show-toplevel') return { stdout: wt }
      if (key === 'worktree list --porcelain')
        return {
          stdout: `worktree ${dir}\nHEAD a\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD b\nbranch refs/heads/wt\n`,
        }
      return { stdout: '' }
    })
    const info = await readProjectGitInfo(wt, exec)
    expect(info?.isLinkedWorktree).toBe(true)
    expect(info?.root).toBe(wt)
  })
})
