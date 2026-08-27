/**
 * Definition-of-Done scenario for the Claude Code provider: Mac A (alice) -> Mac B (bob) with a
 * changed user name and project path. Real git repos, real files, real ScopedFs boundaries.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deriveWorktreeMappings, readProjectGitInfo } from '@devmig/core'
import type {
  ManifestArtifact,
  ManifestProject,
  ManifestProviderSection,
  PathMapping,
  ProjectDescriptor,
  ScannedArtifact,
} from '@devmig/model'
import { noopLogger, realExec } from '@devmig/shared'
import {
  FIXTURE_MCP_SECRET,
  createDestinationMachineFixture,
  createFakeExec,
  createSourceMachineFixture,
  encodeClaudeProjectDir,
  gitTestEnv,
  matchCommand,
  readJsonl,
  type DestinationMachineFixture,
  type SourceMachineFixture,
  type TempRoot,
} from '@devmig/test-utils'
import { makeTempRoot } from '@devmig/test-utils'
import { CLAUDE_CODE_PROVIDER_ID } from './constants'
import { ClaudeCodeProvider } from './provider'
import {
  backupContext,
  describeProject,
  planningContext,
  restoreContext,
  scanContext,
  verifyContext,
} from './test-helpers'

let tmp: TempRoot
let source: SourceMachineFixture
let dest: DestinationMachineFixture
let project: ProjectDescriptor
let newProjectPath: string
let mappings: PathMapping[]
let stagingRoot: string
const provider = new ClaudeCodeProvider({
  isProcessAlive: () => false,
  now: () => new Date('2026-08-28T12:00:00.000Z'),
  platform: 'darwin',
})

function metaKind(a: ScannedArtifact | ManifestArtifact): string {
  return String((a.meta as { artifactKind?: string }).artifactKind)
}

beforeAll(async () => {
  tmp = await makeTempRoot('devmig-claude-e2e-')
  source = await createSourceMachineFixture(path.join(tmp.root, 'macA'))
  dest = await createDestinationMachineFixture(path.join(tmp.root, 'macB'))
  const git = await readProjectGitInfo(source.projectPath, realExec, {
    signal: new AbortController().signal,
    logger: noopLogger,
  })
  project = describeProject(source.projectPath, git)
  newProjectPath = path.join(dest.home.homeDir, 'Developer', 'demo')
  stagingRoot = path.join(tmp.root, 'staging')
  const manifestProject: ManifestProject = {
    id: project.id,
    name: project.name,
    originalPath: project.originalPath,
    canonicalPath: project.canonicalPath,
    ...(git ? { git } : {}),
    providers: [],
  }
  const primary: PathMapping = {
    projectId: project.id,
    oldPath: source.projectPath,
    newPath: newProjectPath,
  }
  mappings = [
    primary,
    ...deriveWorktreeMappings(manifestProject, primary, { homeDir: dest.home.homeDir }),
  ]
})
afterAll(async () => {
  await tmp.cleanup()
})

describe('Claude Code provider: Mac A -> Mac B', () => {
  let projectScanArtifacts: ScannedArtifact[]
  let globalScanArtifacts: ScannedArtifact[]
  let projectSection: ManifestProviderSection
  let globalSection: ManifestProviderSection
  let payloadRoot: string

  it('detects Claude Code', async () => {
    const fake = createFakeExec([
      { match: matchCommand('claude', '--version'), result: { stdout: '2.1.247 (Claude Code)\n' } },
    ])
    const detection = await provider.detect({
      ...scanContext(source.home, [project], { exec: fake.exec }),
    })
    expect(detection).toMatchObject({
      providerId: CLAUDE_CODE_PROVIDER_ID,
      available: true,
      version: '2.1.247',
    })
    const missing = createFakeExec([], { onUnmatched: 'fail' })
    const noCli = await provider.detect({ ...scanContext(dest.home, [], { exec: missing.exec }) })
    expect(noCli.available).toBe(true) // config dir exists
    expect(noCli.details.cli).toBe('missing')
  })

  it('scans the project with the expected artifacts and defaults', async () => {
    const scan = await provider.scanProject(
      project,
      scanContext(source.home, [project], { exec: realExec }),
    )
    expect(scan.detected).toBe(true)
    expect(scan.warnings).toEqual([])
    projectScanArtifacts = scan.artifacts
    const kinds = scan.artifacts.map(
      (a) => [metaKind(a), a.includedByDefault, a.sensitivity] as const,
    )
    expect(kinds.filter((k) => k[0] === 'sessions')).toHaveLength(3)
    expect(kinds.filter((k) => k[0] === 'sessions').every((k) => k[1] && k[2] === 'safe')).toBe(
      true,
    )
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['memory', true, 'safe'],
        ['file-history', true, 'safe'],
        ['session-env', true, 'safe'],
        ['history', true, 'safe'],
        ['claude-json-project', true, 'safe'],
        ['claude-json-mcp-env', false, 'sensitive'],
        ['project-file', true, 'safe'],
      ]),
    )
    const sessions = scan.artifacts.filter((a) => metaKind(a) === 'sessions')
    expect(
      sessions.map((a) => (a.meta as { kind: string; confidence: string }).confidence).sort(),
    ).toEqual(['exact', 'strong', 'strong'])
    expect(sessions.map((a) => (a.meta as { kind: string }).kind).sort()).toEqual([
      'claude-worktree',
      'project',
      'worktree',
    ])
    const projectFiles = scan.artifacts
      .filter((a) => metaKind(a) === 'project-file')
      .map((a) => a.label)
      .sort()
    expect(projectFiles).toEqual(['.claude/settings.local.json', 'CLAUDE.local.md'])
    expect(scan.artifacts.find((a) => metaKind(a) === 'claude-json-mcp-env')?.reasons).toContain(
      'MCP server environment values may contain tokens',
    )
    expect(scan.artifacts.find((a) => metaKind(a) === 'history')?.count).toBe(3)
    expect(scan.summary.map((s) => s.label)).toEqual(
      expect.arrayContaining([
        '5 sessions',
        'project memory',
        'CLAUDE.local.md',
        '1 orphaned worktree session set',
      ]),
    )
    for (const artifact of scan.artifacts) {
      expect(JSON.stringify(artifact)).not.toContain(FIXTURE_MCP_SECRET)
    }
  })

  it('scans the user-wide environment', async () => {
    const scan = await provider.scanGlobal(scanContext(source.home, [project]))
    globalScanArtifacts = scan.artifacts
    const byKind = new Map(scan.artifacts.map((a) => [metaKind(a), a]))
    for (const kind of [
      'global-settings',
      'global-claude-md',
      'global-skills',
      'global-agents',
      'global-statusline',
      'global-plugins',
    ]) {
      expect(byKind.get(kind)).toMatchObject({
        scope: 'user',
        includedByDefault: true,
        sensitivity: 'safe',
        selectable: true,
      })
    }
    const credentials = scan.artifacts.filter((a) => a.sensitivity === 'credential')
    expect(credentials.map((a) => a.label).sort()).toEqual(
      [
        'Claude account identity (oauthAccount)',
        'Keychain item "Claude Code-credentials"',
        'Live session peer tokens (sessions/*.key)',
        'sessions/',
      ].sort(),
    )
    expect(credentials.every((a) => !a.selectable && !a.includedByDefault)).toBe(true)
    const ephemeral = scan.artifacts.filter((a) => a.scope === 'ephemeral')
    expect(ephemeral.map((a) => a.label).sort()).toEqual(['sessions/', 'shell-snapshots/'])
    expect(ephemeral.every((a) => !a.selectable)).toBe(true)
  })

  it('backs up the default selection into the staging directory', async () => {
    const selected = projectScanArtifacts.filter((a) => a.includedByDefault)
    const ctx = backupContext(source.home, stagingRoot, { projectId: project.id })
    await fs.mkdir(ctx.providerDir, { recursive: true })
    const output = await provider.createBackupArtifacts(
      {
        project,
        artifacts: selected,
        scan: {
          providerId: CLAUDE_CODE_PROVIDER_ID,
          projectId: project.id,
          detected: true,
          artifacts: projectScanArtifacts,
          summary: [],
          warnings: [],
          estimatedBytes: 0,
        },
      },
      ctx,
    )
    expect(output.schemaVersion).toBe(1)
    expect(output.warnings).toEqual([])
    expect(output.summary).toMatchObject({ sessionCount: 5, worktreeSessionSets: 1, memoryDirs: 1 })
    expect(output.restoreHints).toMatchObject({
      claudeEncodingVerified: true,
      claudeEncodingRule: 'non-alphanumeric-to-dash',
    })
    expect(output.artifacts.map((a) => a.id).sort()).toEqual(selected.map((a) => a.id).sort())
    for (const artifact of output.artifacts) {
      expect(artifact.payloadPath.startsWith(`${ctx.relDir}/`)).toBe(true)
      await fs.stat(path.join(stagingRoot, ...artifact.payloadPath.split('/')))
    }
    const index = JSON.parse(
      await fs.readFile(path.join(ctx.providerDir, 'index.json'), 'utf8'),
    ) as { matches: { dirName: string }[]; sessionCount: number; encoding: { verified: boolean } }
    expect(index.sessionCount).toBe(5)
    expect(index.encoding.verified).toBe(true)
    expect(index.matches.map((m) => m.dirName).sort()).toEqual(
      [
        source.claude.encoded.project,
        source.claude.encoded.orphanWorktree,
        source.claude.encoded.worktrees[source.worktreePath],
      ].sort(),
    )
    const claudeJsonPayload = await fs.readFile(
      path.join(ctx.providerDir, 'claude-json.json'),
      'utf8',
    )
    expect(claudeJsonPayload).not.toContain(FIXTURE_MCP_SECRET)
    expect(claudeJsonPayload).not.toContain('oauthAccount')
    const history = await readJsonl(path.join(ctx.providerDir, 'history.jsonl'))
    expect(history.records).toHaveLength(3)
    expect(history.records.every((r) => r.project === source.projectPath)).toBe(true)
    projectSection = {
      providerId: CLAUDE_CODE_PROVIDER_ID,
      schemaVersion: 1,
      artifacts: output.artifacts,
      summary: output.summary ?? {},
    }

    const globalCtx = backupContext(source.home, stagingRoot, {})
    await fs.mkdir(globalCtx.providerDir, { recursive: true })
    const globalOut = await provider.createBackupArtifacts(
      {
        artifacts: globalScanArtifacts.filter((a) => a.includedByDefault),
        scan: {
          providerId: CLAUDE_CODE_PROVIDER_ID,
          detected: true,
          artifacts: globalScanArtifacts,
          summary: [],
          warnings: [],
          estimatedBytes: 0,
        },
      },
      globalCtx,
    )
    expect(globalOut.artifacts.map((a) => metaKind(a)).sort()).toEqual([
      'global-agents',
      'global-claude-md',
      'global-plugins',
      'global-settings',
      'global-skills',
      'global-statusline',
    ])
    await fs.stat(path.join(globalCtx.providerDir, 'settings', 'settings.json'))
    await fs.stat(path.join(globalCtx.providerDir, 'skills', 'skills', 'demo-skill', 'SKILL.md'))
    globalSection = {
      providerId: CLAUDE_CODE_PROVIDER_ID,
      schemaVersion: 1,
      artifacts: globalOut.artifacts,
      summary: globalOut.summary ?? {},
    }
    payloadRoot = stagingRoot
    // Sources untouched: the fixture's expected git state still holds and the transcripts are unchanged.
    const original = await fs.readFile(source.claude.sessions[0]!.transcriptPath, 'utf8')
    expect(original).toContain(source.projectPath)
  })

  it('plans and restores onto Mac B with a changed user name and path, then verifies', async () => {
    const input = {
      project: {
        id: project.id,
        name: project.name,
        oldPath: source.projectPath,
        newPath: newProjectPath,
      },
      section: projectSection,
      artifacts: projectSection.artifacts,
    }
    const plan = await provider.planRestore(
      input,
      planningContext(dest.home, payloadRoot, mappings),
    )
    expect(plan.collisions).toEqual([])
    expect(plan.preflight.find((p) => p.id === 'claude-data-dir')?.status).toBe('pass')
    expect(plan.preflight.find((p) => p.id === 'claude-running')?.status).toBe('pass')
    expect(plan.remap.affected).toEqual(
      expect.arrayContaining([
        { label: 'Claude sessions', count: 5 },
        { label: 'Claude project entries', count: 3 },
        { label: 'history entries', count: 3 },
      ]),
    )
    expect(plan.remap.safeRewriteCount).toBeGreaterThanOrEqual(5 * 5)
    expect(plan.remap.unsupportedReferences).toEqual([])
    const destinations = plan.steps.map((s) => s.destination)
    expect(destinations).toContain(
      path.join(dest.home.claudeConfigDir, 'projects', encodeClaudeProjectDir(newProjectPath)),
    )
    expect(destinations).toContain(
      path.join(
        dest.home.claudeConfigDir,
        'projects',
        encodeClaudeProjectDir(path.join(dest.home.homeDir, 'Developer', 'demo-onboarding')),
      ),
    )
    expect(destinations).toContain(
      path.join(
        dest.home.claudeConfigDir,
        'projects',
        encodeClaudeProjectDir(`${newProjectPath}/.claude/worktrees/onboarding`),
      ),
    )

    await fs.mkdir(newProjectPath, { recursive: true })
    // Mac B has a minimal ~/.claude.json (see merge.test.ts for the missing-file case).
    await fs.writeFile(
      dest.home.claudeJsonPath,
      JSON.stringify({ numStartups: 1, userID: 'bob-id' }),
    )
    const roots = [newProjectPath, dest.home.claudeConfigDir, dest.home.claudeJsonPath]
    const result = await provider.restore(
      plan,
      input,
      restoreContext(dest.home, payloadRoot, mappings, roots),
    )
    expect(result.status).toBe('ok')
    expect(result.warnings).toEqual([])
    expect(result.attention?.map((a) => a.id)).toEqual(
      expect.arrayContaining(['reauth', 'mcp-env']),
    )

    const destProjectDir = path.join(
      dest.home.claudeConfigDir,
      'projects',
      encodeClaudeProjectDir(newProjectPath),
    )
    const transcripts = (await fs.readdir(destProjectDir)).filter((f) => f.endsWith('.jsonl'))
    expect(transcripts.sort()).toEqual(
      source.claude.projectSessionIds.map((id) => `${id}.jsonl`).sort(),
    )
    const first = source.claude.sessions.find((s) => s.kind === 'project')!
    const restored = await readJsonl(path.join(destProjectDir, `${first.id}.jsonl`))
    const original = await readJsonl(first.transcriptPath)
    expect(restored.invalidLines.map((l) => l.text)).toEqual(['not json'])
    expect(
      restored.records
        .filter((r) => typeof r.cwd === 'string')
        .every((r) => r.cwd === newProjectPath),
    ).toBe(true)
    for (let i = 0; i < original.records.length; i += 1) {
      expect(JSON.stringify(restored.records[i]?.message ?? null)).toBe(
        JSON.stringify(original.records[i]?.message ?? null),
      )
    }
    const assistant = restored.records.find((r) => r.type === 'assistant') as {
      message: { content: { text?: string }[] }
    }
    expect(assistant.message.content[0]?.text).toContain(source.projectPath)
    const toolResult = restored.records.find((r) => r.toolUseResult) as {
      toolUseResult: { filePath: string; transcriptDir: string }
    }
    expect(toolResult.toolUseResult.filePath).toBe(`${newProjectPath}/README.md`)
    expect(toolResult.toolUseResult.transcriptDir).toBe(source.claude.projectDir) // not under the project mapping -> untouched
    const subagent = await readJsonl(
      path.join(destProjectDir, first.id, 'subagents', 'agent-1.jsonl'),
    )
    expect(subagent.records.every((r) => r.cwd === newProjectPath)).toBe(true)
    await fs.stat(path.join(destProjectDir, first.id, 'tool-results', 'result-1.txt'))
    await fs.stat(path.join(destProjectDir, 'memory', 'MEMORY.md'))
    await fs.stat(path.join(dest.home.claudeConfigDir, 'file-history', first.id, 'abc123@v1'))
    await fs.stat(
      path.join(dest.home.claudeConfigDir, 'session-env', first.id, 'sessionstart-hook-1.sh'),
    )
    const history = await readJsonl(path.join(dest.home.claudeConfigDir, 'history.jsonl'))
    expect(history.records).toHaveLength(3)
    expect(history.records.every((r) => r.project === newProjectPath)).toBe(true)
    const claudeJson = JSON.parse(await fs.readFile(dest.home.claudeJsonPath, 'utf8')) as {
      numStartups: number
      userID: string
      projects: Record<string, { mcpServers?: Record<string, { env?: unknown }> }>
    }
    expect(claudeJson.numStartups).toBe(1)
    expect(claudeJson.userID).toBe('bob-id')
    expect(Object.keys(claudeJson.projects).sort()).toEqual(
      [
        newProjectPath,
        path.join(dest.home.homeDir, 'Developer', 'demo-onboarding'),
        `${newProjectPath}/.claude/worktrees/onboarding`,
      ].sort(),
    )
    expect(claudeJson.projects[newProjectPath]?.mcpServers?.demo?.env).toBeUndefined()
    expect(await fs.readFile(dest.home.claudeJsonPath, 'utf8')).not.toContain(FIXTURE_MCP_SECRET)
    expect(await fs.readdir(path.join(dest.home.claudeConfigDir, 'devmig-backups'))).toHaveLength(1)
    expect(await fs.readFile(path.join(newProjectPath, 'CLAUDE.local.md'), 'utf8')).toContain(
      'Local notes',
    )
    await fs.stat(path.join(newProjectPath, '.claude', 'settings.local.json'))
    const stray = (await fs.readdir(destProjectDir)).filter(
      (f) => f.includes('devmig-tmp') || f.includes('incoming'),
    )
    expect(stray).toEqual([])

    const verification = await provider.verify(
      { plan, result, input },
      verifyContext(dest.home, payloadRoot, mappings),
    )
    expect(verification.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(verification.checks.filter((c) => c.status === 'warn')).toEqual([])
    expect(
      verification.checks.some((c) => c.label.includes('remapped safely') && c.status === 'pass'),
    ).toBe(true)
    expect(verification.checks.find((c) => c.id === 'file-history')).toMatchObject({
      status: 'pass',
      detail: '10/10 blobs',
    })

    // The source machine is untouched.
    expect(await fs.readFile(first.transcriptPath, 'utf8')).toContain(source.projectPath)
    expect(
      JSON.stringify(JSON.parse(await fs.readFile(source.home.claudeJsonPath, 'utf8'))),
    ).toContain(FIXTURE_MCP_SECRET)
  })

  it('reports collisions on a second restore and skips identical content', async () => {
    const input = {
      project: {
        id: project.id,
        name: project.name,
        oldPath: source.projectPath,
        newPath: newProjectPath,
      },
      section: projectSection,
      artifacts: projectSection.artifacts,
    }
    const plan = await provider.planRestore(
      input,
      planningContext(dest.home, payloadRoot, mappings),
    )
    const kinds = plan.collisions.map((c) => c.kind).sort()
    expect(kinds).toEqual([
      'claude-project-exists',
      'claude-project-exists',
      'claude-project-exists',
      'directory-exists',
      'file-exists',
      'file-exists',
      'json-entry-exists',
      'json-entry-exists',
      'json-entry-exists',
    ])
    expect(
      plan.collisions.every(
        (c) => c.allowedPolicies[0] === 'skip' || c.allowedPolicies[0] === 'merge',
      ),
    ).toBe(true)
    const roots = [newProjectPath, dest.home.claudeConfigDir, dest.home.claudeJsonPath]
    const result = await provider.restore(
      plan,
      input,
      restoreContext(dest.home, payloadRoot, mappings, roots),
    )
    expect(result.status).toBe('ok')
    expect(result.warnings).toEqual([])
    const sessionItems = result.items.filter((i) => i.label.startsWith('Sessions'))
    expect(sessionItems).toHaveLength(3)
    expect(sessionItems.every((i) => i.detail?.includes('identical skipped'))).toBe(true)
    expect(result.items.find((i) => i.label === 'Prompt history')?.detail).toBe(
      '0 entries appended, 3 already present',
    )
    expect(result.items.find((i) => i.label.includes('project entries'))?.detail).toContain(
      'already present',
    )
    const destProjectDir = path.join(
      dest.home.claudeConfigDir,
      'projects',
      encodeClaudeProjectDir(newProjectPath),
    )
    expect((await fs.readdir(destProjectDir)).filter((f) => f.includes('conflict'))).toEqual([])
    const verification = await provider.verify(
      { plan, result, input },
      verifyContext(dest.home, payloadRoot, mappings),
    )
    expect(verification.checks.filter((c) => c.status === 'fail')).toEqual([])
  })

  it('restores the user-wide environment and merges on the second run', async () => {
    const input = { section: globalSection, artifacts: globalSection.artifacts }
    const plan = await provider.planRestore(
      input,
      planningContext(dest.home, payloadRoot, mappings),
    )
    expect(plan.collisions).toEqual([])
    const roots = [dest.home.claudeConfigDir, dest.home.claudeJsonPath]
    const result = await provider.restore(
      plan,
      input,
      restoreContext(dest.home, payloadRoot, mappings, roots),
    )
    expect(result.status).toBe('ok')
    await fs.stat(path.join(dest.home.claudeConfigDir, 'settings.json'))
    await fs.stat(path.join(dest.home.claudeConfigDir, 'skills', 'demo-skill', 'SKILL.md'))
    await fs.stat(path.join(dest.home.claudeConfigDir, 'agents', 'reviewer.md'))
    await fs.stat(path.join(dest.home.claudeConfigDir, 'plugins', 'installed_plugins.json'))
    const verification = await provider.verify(
      { plan, result, input },
      verifyContext(dest.home, payloadRoot, mappings),
    )
    expect(verification.checks.filter((c) => c.status === 'fail')).toEqual([])

    await fs.writeFile(
      path.join(dest.home.claudeConfigDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet', theme: 'dark' }),
    )
    const second = await provider.planRestore(
      input,
      planningContext(dest.home, payloadRoot, mappings),
    )
    const settings = second.collisions.find((c) => c.path.endsWith('settings.json'))
    expect(settings).toMatchObject({
      kind: 'file-exists',
      policy: 'skip',
      allowedPolicies: ['skip', 'merge', 'backup-then-replace'],
    })
    expect(second.collisions.find((c) => c.path.endsWith('/skills'))).toMatchObject({
      kind: 'directory-exists',
      policy: 'merge',
    })
    const merged = await provider.restore(
      second,
      input,
      restoreContext(dest.home, payloadRoot, mappings, roots, {
        collisionDecisions: { [settings!.id]: 'merge' },
      }),
    )
    expect(merged.status).toBe('ok')
    const settingsJson = JSON.parse(
      await fs.readFile(path.join(dest.home.claudeConfigDir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(settingsJson.model).toBe('sonnet')
    expect(settingsJson.theme).toBe('dark')
    expect(settingsJson.cleanupPeriodDays).toBe(90)
  })

  it('uses git check-ignore through the Exec abstraction with safe arguments', async () => {
    const fake = createFakeExec([
      {
        match: matchCommand('git', 'check-ignore'),
        result: { exitCode: 0, stdout: 'CLAUDE.local.md\0.claude/settings.local.json\0' },
      },
    ])
    const scan = await provider.scanProject(
      project,
      scanContext(source.home, [project], { exec: fake.exec }),
    )
    const call = fake.callsMatching(matchCommand('git', 'check-ignore'))[0]
    expect(call?.args).toEqual(['check-ignore', '--no-index', '-z', '--stdin'])
    expect(call?.options?.cwd).toBe(source.projectPath)
    expect(String(call?.options?.input)).toContain('CLAUDE.local.md\0')
    expect(
      scan.artifacts
        .filter((a) => metaKind(a) === 'project-file')
        .map((a) => a.label)
        .sort(),
    ).toEqual(['.claude/settings.local.json', 'CLAUDE.local.md'])
    void gitTestEnv
  })
})
