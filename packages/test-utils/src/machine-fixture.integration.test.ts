import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '@devmig/shared'
import { encodeClaudeProjectDir } from './claude-encoding'
import { parseStatusV2 } from './git-parsers'
import { captureGitState, compareGitState } from './git-state'
import { readJsonl } from './jsonl'
import {
  createDestinationMachineFixture,
  createSourceMachineFixture,
  type SourceMachineFixture,
} from './machine-fixture'
import { makeTempRoot, type TempRoot } from './temp'

let tmp: TempRoot
let source: SourceMachineFixture
let buildMs = 0

beforeAll(async () => {
  tmp = await makeTempRoot('devmig-machines-')
  const started = performance.now()
  source = await createSourceMachineFixture(tmp.root)
  buildMs = performance.now() - started
})

afterAll(async () => {
  await tmp.cleanup()
})

describe('createSourceMachineFixture ("Mac A")', () => {
  it('builds in under 10 seconds', () => {
    expect(buildMs).toBeLessThan(10_000)
  })

  it('places the repo, worktree and Claude state under the fake home for alice', async () => {
    const { home, repo, claude } = source
    expect(home.userName).toBe('alice')
    expect(home.homeDir).toBe(path.join(tmp.root, 'Users', 'alice'))
    expect(source.projectPath).toBe(path.join(home.projectsDir, 'demo'))
    expect(repo.path).toBe(source.projectPath)
    expect(source.worktreePath).toBe(path.join(home.projectsDir, 'demo-onboarding'))
    expect(repo.worktree?.path).toBe(source.worktreePath)
    expect(repo.env.HOME).toBe(home.homeDir)
    expect(claude.claudeConfigDir).toBe(home.claudeConfigDir)
    expect(claude.claudeJsonPath).toBe(home.claudeJsonPath)
    expect(claude.projectPath).toBe(repo.path)
    expect(claude.otherProjectPath).toBe(path.join(home.projectsDir, 'unrelated-project'))
    expect(claude.encoded.project).toBe(encodeClaudeProjectDir(source.projectPath))
    expect(claude.encoded.project.endsWith('-Users-alice-Documents-GitHub-demo')).toBe(true)
    expect(claude.projectDir).toBe(
      path.join(home.claudeConfigDir, 'projects', claude.encoded.project),
    )
    expect(claude.sessions.map((s) => s.kind)).toEqual([
      'project',
      'project',
      'project',
      'worktree',
      'orphan-worktree',
      'other-project',
    ])
    const wt = claude.sessions.find((s) => s.kind === 'worktree')
    expect(wt).toMatchObject({ cwd: source.worktreePath, gitBranch: 'feature/onboarding' })
    const orphan = claude.sessions.find((s) => s.kind === 'orphan-worktree')
    expect(orphan?.cwd).toBe(path.join(repo.path, '.claude', 'worktrees', 'onboarding'))
    await expect(fs.stat(orphan?.cwd ?? '')).rejects.toMatchObject({ code: 'ENOENT' })
    // The .env.local from the git fixture is present and gitignored.
    expect(repo.files.envLocal).toBe(path.join(repo.path, '.env.local'))
    expect(source.secrets).toEqual([...repo.secrets, ...claude.secrets])
    expect(source.secrets.length).toBeGreaterThanOrEqual(4)
  })

  it('re-captures git expectations after the Claude project files were written', async () => {
    const { repo } = source
    const fresh = await captureGitState(repo.path, realExec, { env: repo.env })
    expect(compareGitState(repo.expected, fresh)).toEqual({ equal: true, differences: [] })
    const untracked = parseStatusV2(repo.expected.statusV2)
      .filter((e) => e.kind === 'untracked')
      .map((e) => e.path)
      .sort()
    // CLAUDE.md, .mcp.json and .nvmrc are untracked; CLAUDE.local.md and .claude/settings.local.json are ignored.
    expect(untracked).toEqual(['.mcp.json', '.nvmrc', 'CLAUDE.md', 'notes/todo.md'])
    expect(repo.expected.untracked).toEqual(untracked)
    if (repo.worktree) {
      const freshWt = await captureGitState(repo.worktree.path, realExec, { env: repo.env })
      expect(compareGitState(repo.worktree.expected, freshWt).equal).toBe(true)
    }
  })

  it('transcripts of project sessions carry the real project path as cwd', async () => {
    for (const id of source.claude.projectSessionIds) {
      const session = source.claude.sessions.find((s) => s.id === id)
      if (!session) throw new Error('missing session')
      const { records } = await readJsonl(session.transcriptPath)
      const user = records.find((r) => r.type === 'user')
      expect(user?.cwd).toBe(source.projectPath)
    }
  })
})

describe('createDestinationMachineFixture ("Mac B")', () => {
  it('creates an empty ~/.claude for bob beside alice', async () => {
    const dest = await createDestinationMachineFixture(tmp.root)
    expect(dest.home.userName).toBe('bob')
    expect(dest.home.homeDir).toBe(path.join(tmp.root, 'Users', 'bob'))
    expect(path.dirname(dest.home.homeDir)).toBe(path.dirname(source.home.homeDir))
    expect(await fs.readdir(dest.home.claudeConfigDir)).toEqual([])
    await expect(fs.stat(dest.home.claudeJsonPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(dest.home.projectsDir)).toEqual([])
    // Source is untouched by creating the destination.
    expect(await fs.readdir(source.home.claudeConfigDir)).not.toEqual([])
  })
})
