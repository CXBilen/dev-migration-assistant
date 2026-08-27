import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '@devmig/shared'
import { makeTempRoot, type TempRoot } from '../testing/engine-fixtures'
import { readProjectGitInfo } from './git-info'

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: '',
  PATH: process.env.PATH,
}

async function git(cwd: string, args: string[], home: string): Promise<string> {
  const result = await realExec('git', args, { cwd, env: { ...GIT_ENV, HOME: home } })
  return result.stdout.trim()
}

describe('readProjectGitInfo (real git)', () => {
  let tmp: TempRoot
  let home: string
  let repo: string

  beforeAll(async () => {
    tmp = await makeTempRoot('devmig-gitinfo-')
    home = path.join(tmp.root, 'home')
    await fs.mkdir(home, { recursive: true })
    repo = path.join(tmp.root, 'proj')
    await fs.mkdir(repo)
    await git(repo, ['init', '-q', '-b', 'main'], home)
    await fs.writeFile(path.join(repo, 'README.md'), '# hi\n')
    await git(repo, ['add', '.'], home)
    await git(repo, ['commit', '-q', '-m', 'init'], home)
    await git(repo, ['remote', 'add', 'origin', 'https://example.com/me/proj.git'], home)
    await git(
      repo,
      ['worktree', 'add', '-q', '-b', 'feature', path.join(tmp.root, 'proj-feature')],
      home,
    )
    await fs.mkdir(path.join(repo, '.claude', 'worktrees'), { recursive: true })
    await git(
      repo,
      ['worktree', 'add', '-q', '--detach', path.join(repo, '.claude', 'worktrees', 'agent')],
      home,
    )
  })

  afterAll(async () => {
    await tmp.cleanup()
  })

  it('describes a repository with a sibling and a child worktree', async () => {
    const info = await readProjectGitInfo(repo, realExec)
    expect(info).toBeDefined()
    expect(info?.root).toBe(repo)
    expect(info?.branch).toBe('main')
    expect(info?.head).toMatch(/^[0-9a-f]{40}$/)
    expect(info?.detached).toBe(false)
    expect(info?.isLinkedWorktree).toBe(false)
    expect(info?.commonDir).toBe(path.join(repo, '.git'))
    expect(info?.remotes).toEqual([{ name: 'origin', fetchUrl: 'https://example.com/me/proj.git' }])
    const byPath = new Map(info?.worktrees.map((w) => [w.path, w]))
    expect(byPath.get(repo)).toMatchObject({ isPrimary: true, branch: 'main' })
    expect(byPath.get(path.join(tmp.root, 'proj-feature'))).toMatchObject({
      isPrimary: false,
      branch: 'feature',
      relativeToPrimary: '../proj-feature',
    })
    expect(byPath.get(path.join(repo, '.claude', 'worktrees', 'agent'))).toMatchObject({
      isPrimary: false,
      branch: null,
      detached: true,
      relativeToPrimary: path.join('.claude', 'worktrees', 'agent'),
    })
  })

  it('describes a linked worktree selected directly', async () => {
    const info = await readProjectGitInfo(path.join(tmp.root, 'proj-feature'), realExec)
    expect(info?.isLinkedWorktree).toBe(true)
    expect(info?.branch).toBe('feature')
    expect(info?.root).toBe(path.join(tmp.root, 'proj-feature'))
  })

  it('describes a subdirectory by its repository root', async () => {
    const sub = path.join(repo, 'src')
    await fs.mkdir(sub, { recursive: true })
    const info = await readProjectGitInfo(sub, realExec)
    expect(info?.root).toBe(repo)
  })

  it('handles an empty repository (no HEAD yet)', async () => {
    const empty = path.join(tmp.root, 'empty')
    await fs.mkdir(empty)
    await git(empty, ['init', '-q', '-b', 'main'], home)
    const info = await readProjectGitInfo(empty, realExec)
    expect(info).toBeDefined()
    expect(info?.head).toBeNull()
    expect(info?.branch).toBe('main')
    expect(info?.detached).toBe(false)
  })

  it('returns undefined for a plain directory', async () => {
    const plain = path.join(tmp.root, 'plain')
    await fs.mkdir(plain)
    await expect(readProjectGitInfo(plain, realExec)).resolves.toBeUndefined()
  })
})
