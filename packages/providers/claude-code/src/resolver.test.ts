import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectDescriptor } from '@devmig/model'
import {
  createClaudeFixture,
  createFakeHome,
  encodeClaudeProjectDir,
  makeTempRoot,
  writeJsonlLines,
  type ClaudeFixture,
  type FakeHome,
  type TempRoot,
} from '@devmig/test-utils'
import { ClaudeProjectResolver, enumerateCandidates, sessionIdFromFileName } from './resolver'
import { describeProject, scanContext } from './test-helpers'
import { ClaudeCodeProvider } from './provider'

let tmp: TempRoot
let home: FakeHome
let fixture: ClaudeFixture
let projectPath: string
let worktreePath: string

function gitInfo(project: string, worktrees: string[]): ProjectDescriptor['git'] {
  return {
    root: project,
    remotes: [],
    head: null,
    branch: 'main',
    detached: false,
    isLinkedWorktree: false,
    worktrees: [
      {
        path: project,
        branch: 'main',
        head: null,
        isPrimary: true,
        detached: false,
        locked: false,
        prunable: false,
      },
      ...worktrees.map((w) => ({
        path: w,
        branch: `feature/${path.basename(w)}`,
        head: null,
        isPrimary: false,
        detached: false,
        locked: false,
        prunable: false,
      })),
    ],
  }
}

function resolveCtx(projects: ProjectDescriptor[], claudeConfigDir = home.claudeConfigDir) {
  return { claudeConfigDir, claudeJsonPath: home.claudeJsonPath, allProjects: projects }
}

beforeEach(async () => {
  tmp = await makeTempRoot('devmig-claude-resolver-')
  home = await createFakeHome(tmp.root)
  projectPath = path.join(home.projectsDir, 'demo')
  worktreePath = path.join(home.projectsDir, 'demo-onboarding')
  fixture = await createClaudeFixture({
    claudeConfigDir: home.claudeConfigDir,
    claudeJsonPath: home.claudeJsonPath,
    projectPath,
    worktreePaths: [worktreePath],
    includeOrphanWorktreeSession: true,
    createProjectFiles: false,
  })
})
afterEach(async () => {
  await tmp.cleanup()
})

describe('sessionIdFromFileName', () => {
  it('accepts uuid-like names and rejects hidden/odd files', () => {
    expect(sessionIdFromFileName('abc-123.jsonl')).toBe('abc-123')
    expect(sessionIdFromFileName('.hidden.jsonl')).toBeNull()
    expect(sessionIdFromFileName('notes.md')).toBeNull()
    expect(sessionIdFromFileName('weird name.jsonl')).toBeNull()
  })

  it("never treats the provider's own conflict/incoming files as sessions", () => {
    expect(sessionIdFromFileName('abc-123.devmig-conflict.jsonl')).toBeNull()
    expect(sessionIdFromFileName('abc-123.devmig-incoming.jsonl')).toBeNull()
  })
})

describe('enumerateCandidates', () => {
  it('samples cwd evidence, session ids, versions and memory presence per directory', async () => {
    const candidates = await enumerateCandidates(home.claudeConfigDir)
    const names = candidates.map((c) => c.dirName)
    expect(names).toContain(fixture.encoded.project)
    expect(names).toContain(fixture.encoded.orphanWorktree)
    expect(names).toContain(fixture.encoded.otherProject)
    const project = candidates.find((c) => c.dirName === fixture.encoded.project)
    expect(project?.cwds).toEqual([projectPath])
    expect(project?.sessionIds).toEqual([...fixture.projectSessionIds].sort())
    expect(project?.claudeVersions).toEqual(['2.1.247'])
    expect(project?.hasMemory).toBe(true)
    expect(candidates.find((c) => c.dirName === fixture.encoded.otherProject)?.hasMemory).toBe(
      false,
    )
  })
})

describe('ClaudeProjectResolver', () => {
  it('classifies exact / worktree / claude-worktree matches and ignores unrelated projects', async () => {
    const project = describeProject(projectPath, gitInfo(projectPath, [worktreePath]))
    const result = await new ClaudeProjectResolver().resolve(project, resolveCtx([project]))
    expect(result.warnings).toEqual([])
    const byName = new Map(result.matches.map((m) => [m.dirName, m]))
    expect(byName.get(fixture.encoded.project)).toMatchObject({
      kind: 'project',
      confidence: 'exact',
      matchedProjectPath: projectPath,
      sessionCount: fixture.projectSessionIds.length,
      hasMemory: true,
    })
    expect(byName.get(fixture.encoded.project)?.evidence.join(' ')).toMatch(
      /cwd equals the project path/,
    )
    expect(byName.get(fixture.encoded.project)?.sizeBytes).toBeGreaterThan(0)
    expect(byName.get(fixture.encoded.worktrees[worktreePath] as string)).toMatchObject({
      kind: 'worktree',
      confidence: 'strong',
      matchedProjectPath: worktreePath,
      hasMemory: false,
    })
    expect(byName.get(fixture.encoded.orphanWorktree)).toMatchObject({
      kind: 'claude-worktree',
      confidence: 'strong',
      matchedProjectPath: fixture.orphanWorktreePath,
    })
    expect(byName.has(fixture.encoded.otherProject)).toBe(false)
    const sessionIds = result.matches.flatMap((m) => m.sessionIds).sort()
    expect(sessionIds).toEqual([...fixture.expectedProjectSessionIds].sort())
    expect(result.encodingSamples.map((s) => s.dirName)).toContain(fixture.encoded.otherProject)
  })

  it('reports name-only directories as weak and raises them to strong with ~/.claude.json or history evidence', async () => {
    const weakProject = path.join(home.projectsDir, 'weak')
    const weakDir = path.join(fixture.projectsDir, encodeClaudeProjectDir(weakProject))
    await writeJsonlLines(path.join(weakDir, 'aaaa.jsonl'), [
      JSON.stringify({ type: 'custom-title', customTitle: 'x' }),
    ])
    const orphanNameOnly = path.join(
      fixture.projectsDir,
      encodeClaudeProjectDir(`${weakProject}/.claude/worktrees/feat`),
    )
    await writeJsonlLines(path.join(orphanNameOnly, 'bbbb.jsonl'), ['not json'])
    const project = describeProject(weakProject)
    const resolver = new ClaudeProjectResolver()
    const weak = await resolver.resolve(project, resolveCtx([project]))
    expect(weak.matches.map((m) => [m.dirName, m.kind, m.confidence])).toEqual([
      [encodeClaudeProjectDir(weakProject), 'project', 'weak'],
      [orphanNameOnly.split(path.sep).pop(), 'claude-worktree', 'weak'],
    ])
    expect(weak.matches[1]?.matchedProjectPath).toBe(`${weakProject}/.claude/worktrees/feat`)

    // ~/.claude.json entry for the path -> strong
    const json = JSON.parse(await fs.readFile(home.claudeJsonPath, 'utf8')) as {
      projects: Record<string, unknown>
    }
    json.projects[weakProject] = { allowedTools: [] }
    await fs.writeFile(home.claudeJsonPath, JSON.stringify(json))
    const strong = await resolver.resolve(project, resolveCtx([project]))
    const strongMatch = strong.matches.find(
      (m) => m.dirName === encodeClaudeProjectDir(weakProject),
    )
    expect(strongMatch?.confidence).toBe('strong')
    expect(strongMatch?.evidence.some((e) => e.includes('~/.claude.json has an entry'))).toBe(true)

    // history.jsonl attribution alone is enough too
    delete json.projects[weakProject]
    await fs.writeFile(home.claudeJsonPath, JSON.stringify(json))
    await fs.appendFile(
      path.join(home.claudeConfigDir, 'history.jsonl'),
      `${JSON.stringify({ display: 'hi', pastedContents: {}, timestamp: 1, project: weakProject, sessionId: 'aaaa' })}\n`,
    )
    const viaHistory = await resolver.resolve(project, resolveCtx([project]))
    const historyMatch = viaHistory.matches.find(
      (m) => m.dirName === encodeClaudeProjectDir(weakProject),
    )
    expect(historyMatch?.confidence).toBe('strong')
    expect(
      historyMatch?.evidence.some((e) => e.includes('history.jsonl attributes 1 session')),
    ).toBe(true)
  })

  it('does not attribute a directory whose name matches but whose transcripts ran elsewhere', async () => {
    const elsewhere = path.join(home.projectsDir, 'elsewhere')
    const dir = path.join(fixture.projectsDir, encodeClaudeProjectDir(elsewhere))
    await writeJsonlLines(path.join(dir, 'cccc.jsonl'), [
      JSON.stringify({ type: 'user', cwd: '/Users/someone/else' }),
    ])
    const project = describeProject(elsewhere)
    const result = await new ClaudeProjectResolver().resolve(project, resolveCtx([project]))
    expect(result.matches).toEqual([])
    expect(result.warnings[0]).toMatch(
      /reproduces the name of .* but its transcripts ran in \/Users\/someone\/else/,
    )
  })

  it('assigns nested selections to the deepest project and warns CLAUDE_PROJECT_AMBIGUOUS', async () => {
    const sub = path.join(projectPath, 'packages', 'sub')
    const subDir = path.join(fixture.projectsDir, encodeClaudeProjectDir(sub))
    await writeJsonlLines(path.join(subDir, 'dddd.jsonl'), [
      JSON.stringify({ type: 'user', cwd: sub, sessionId: 'dddd' }),
    ])
    const parent = describeProject(projectPath, gitInfo(projectPath, [worktreePath]))
    const child = describeProject(sub)
    const resolver = new ClaudeProjectResolver()
    const parentResult = await resolver.resolve(parent, resolveCtx([parent, child]))
    expect(parentResult.matches.map((m) => m.dirName)).not.toContain(encodeClaudeProjectDir(sub))
    expect(
      parentResult.warnings.some(
        (w) => w.startsWith('CLAUDE_PROJECT_AMBIGUOUS') && w.includes('assigned to "sub"'),
      ),
    ).toBe(true)
    const childResult = await resolver.resolve(child, resolveCtx([parent, child]))
    expect(childResult.matches.map((m) => [m.dirName, m.confidence])).toEqual([
      [encodeClaudeProjectDir(sub), 'exact'],
    ])
    expect(childResult.warnings.some((w) => w.startsWith('CLAUDE_PROJECT_AMBIGUOUS'))).toBe(true)
    // Without the nested selection the parent owns the subdirectory sessions (strong, child cwd).
    const alone = await resolver.resolve(parent, resolveCtx([parent]))
    expect(alone.matches.find((m) => m.dirName === encodeClaudeProjectDir(sub))).toMatchObject({
      confidence: 'strong',
      kind: 'project',
    })
  })

  it('lets a sibling worktree selected as its own project win its directory', async () => {
    const parent = describeProject(projectPath, gitInfo(projectPath, [worktreePath]))
    const worktreeProject = describeProject(worktreePath)
    const resolver = new ClaudeProjectResolver()
    const parentResult = await resolver.resolve(parent, resolveCtx([parent, worktreeProject]))
    const wtDir = fixture.encoded.worktrees[worktreePath] as string
    expect(parentResult.matches.map((m) => m.dirName)).not.toContain(wtDir)
    expect(parentResult.warnings.some((w) => w.includes(wtDir))).toBe(true)
    const wtResult = await resolver.resolve(worktreeProject, resolveCtx([parent, worktreeProject]))
    expect(wtResult.matches.map((m) => [m.dirName, m.confidence])).toEqual([[wtDir, 'exact']])
  })

  it('honours a CLAUDE_CONFIG_DIR override (resolves against the directory in the context)', async () => {
    const workConfigDir = path.join(home.homeDir, '.claude-work')
    const workProject = path.join(home.projectsDir, 'work-project')
    const work = await createClaudeFixture({
      claudeConfigDir: workConfigDir,
      claudeJsonPath: path.join(workConfigDir, '.claude.json'),
      projectPath: workProject,
      includeOrphanWorktreeSession: false,
      createProjectFiles: false,
      sessionCount: 2,
    })
    const project = describeProject(workProject)
    const resolver = new ClaudeProjectResolver()
    const viaDefault = await resolver.resolve(project, resolveCtx([project]))
    expect(viaDefault.matches).toEqual([])
    const viaOverride = await resolver.resolve(project, resolveCtx([project], workConfigDir))
    expect(viaOverride.matches.map((m) => [m.dirName, m.confidence])).toEqual([
      [work.encoded.project, 'exact'],
    ])
    // The provider passes ctx.claudeConfigDir straight through.
    const provider = new ClaudeCodeProvider({ platform: 'linux' })
    const scan = await provider.scanProject(
      project,
      scanContext(
        {
          ...home,
          claudeConfigDir: workConfigDir,
          claudeJsonPath: path.join(workConfigDir, '.claude.json'),
          env: { ...home.env, CLAUDE_CONFIG_DIR: workConfigDir },
        },
        [project],
      ),
    )
    expect(
      scan.artifacts.some(
        (a) =>
          (a.meta as { artifactKind?: string; dirName?: string }).artifactKind === 'sessions' &&
          (a.meta as { dirName?: string }).dirName === work.encoded.project,
      ),
    ).toBe(true)
  })
})
