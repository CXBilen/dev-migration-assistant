/**
 * Merge semantics of planRestore/restore against synthetic payloads: ~/.claude.json add-only merge
 * with a backup copy and no identity keys, session merge (identical skip / conflict file),
 * memory add-only, project-file collision policies and the ScopedFs boundary.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ManifestArtifact, ManifestProviderSection } from '@devmig/model'
import {
  createFakeHome,
  makeTempRoot,
  writeJsonlLines,
  type FakeHome,
  type TempRoot,
} from '@devmig/test-utils'
import { CLAUDE_CODE_PROVIDER_ID } from './constants'
import { encodeProjectDirName } from './encoding'
import { ClaudeCodeProvider } from './provider'
import type { BackupIndex } from './schema'
import { planningContext, restoreContext, verifyContext } from './test-helpers'

const OLD = '/Users/alice/Documents/GitHub/demo'
const SID = '11111111-1111-4111-8111-111111111111'
const SID2 = '22222222-2222-4222-8222-222222222222'
const PROJECT_ID = 'p1'
const REL = `projects/${PROJECT_ID}/claude-code`

let tmp: TempRoot
let home: FakeHome
let payloadRoot: string
let newPath: string
const provider = new ClaudeCodeProvider({
  isProcessAlive: () => false,
  now: () => new Date('2026-08-28T10:00:00.000Z'),
  platform: 'linux',
})

async function writePayload(): Promise<{
  section: ManifestProviderSection
  artifacts: ManifestArtifact[]
}> {
  const dir = path.join(payloadRoot, ...REL.split('/'))
  const dirName = encodeProjectDirName(OLD).name
  await writeJsonlLines(path.join(dir, 'sessions', dirName, `${SID}.jsonl`), [
    JSON.stringify({
      type: 'user',
      cwd: OLD,
      sessionId: SID,
      message: { role: 'user', content: `look at ${OLD}/x` },
    }),
    'broken line',
  ])
  await writeJsonlLines(path.join(dir, 'sessions', dirName, `${SID2}.jsonl`), [
    JSON.stringify({ type: 'user', cwd: OLD, sessionId: SID2 }),
  ])
  await fs.mkdir(path.join(dir, 'memory', dirName), { recursive: true })
  await fs.writeFile(path.join(dir, 'memory', dirName, 'MEMORY.md'), '# memory\n')
  await fs.writeFile(
    path.join(dir, 'claude-json.json'),
    JSON.stringify({
      projects: {
        [OLD]: {
          allowedTools: ['Bash(git:*)'],
          hasTrustDialogAccepted: true,
          mcpServers: { demo: { type: 'stdio', command: 'npx' } },
        },
      },
      mcpEnv: { [OLD]: { demo: { env: { DEMO_TOKEN: 'tok_secret_123' } } } },
    }),
  )
  await fs.mkdir(path.join(dir, 'project-files'), { recursive: true })
  await fs.writeFile(path.join(dir, 'project-files', 'CLAUDE.local.md'), 'local notes\n')
  const index: BackupIndex = {
    schemaVersion: 1,
    section: 'project',
    claudeCodeVersions: ['2.1.247'],
    encoding: {
      rule: 'non-alphanumeric-to-dash',
      verified: true,
      matched: 1,
      mismatched: 0,
      unknown: 0,
    },
    matches: [
      { dirName, kind: 'project', sourcePath: OLD, sessionIds: [SID, SID2], confidence: 'exact' },
    ],
    sessionCount: 2,
    memoryDirs: [dirName],
    fileHistorySessionIds: [],
    mcpEnvServersExcluded: ['demo'],
    project: { id: PROJECT_ID, path: OLD },
  }
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(index))
  const meta = (extra: Record<string, unknown>): Record<string, unknown> => ({
    indexPayloadPath: `${REL}/index.json`,
    ...extra,
  })
  const artifacts: ManifestArtifact[] = [
    {
      id: `${CLAUDE_CODE_PROVIDER_ID}:${PROJECT_ID}:sessions:${dirName}`,
      providerId: CLAUDE_CODE_PROVIDER_ID,
      kind: 'file-set',
      label: 'sessions',
      payloadPath: `${REL}/sessions/${dirName}`,
      sizeBytes: 10,
      sensitivity: 'safe',
      sourcePath: OLD,
      meta: meta({
        artifactKind: 'sessions',
        dirName,
        sourcePath: OLD,
        kind: 'project',
        confidence: 'exact',
        sessionIds: [SID, SID2],
      }),
    },
    {
      id: `${CLAUDE_CODE_PROVIDER_ID}:${PROJECT_ID}:memory:${dirName}`,
      providerId: CLAUDE_CODE_PROVIDER_ID,
      kind: 'directory',
      label: 'memory',
      payloadPath: `${REL}/memory/${dirName}`,
      sizeBytes: 10,
      sensitivity: 'safe',
      meta: meta({ artifactKind: 'memory', dirName, sourcePath: OLD }),
    },
    {
      id: `${CLAUDE_CODE_PROVIDER_ID}:${PROJECT_ID}:claude-json:project`,
      providerId: CLAUDE_CODE_PROVIDER_ID,
      kind: 'json-fragment',
      label: 'claude.json entries',
      payloadPath: `${REL}/claude-json.json`,
      sizeBytes: 10,
      sensitivity: 'safe',
      meta: meta({ artifactKind: 'claude-json-project', paths: [OLD] }),
    },
    {
      id: `${CLAUDE_CODE_PROVIDER_ID}:${PROJECT_ID}:claude-json:mcp-env`,
      providerId: CLAUDE_CODE_PROVIDER_ID,
      kind: 'json-fragment',
      label: 'mcp env',
      payloadPath: `${REL}/claude-json.json`,
      sizeBytes: 10,
      sensitivity: 'sensitive',
      meta: meta({ artifactKind: 'claude-json-mcp-env', paths: [OLD], servers: ['demo'] }),
    },
    {
      id: `${CLAUDE_CODE_PROVIDER_ID}:${PROJECT_ID}:project-file:CLAUDE.local.md`,
      providerId: CLAUDE_CODE_PROVIDER_ID,
      kind: 'file',
      label: 'CLAUDE.local.md',
      payloadPath: `${REL}/project-files/CLAUDE.local.md`,
      sizeBytes: 10,
      sensitivity: 'safe',
      meta: meta({ artifactKind: 'project-file', relativePath: 'CLAUDE.local.md' }),
    },
  ]
  const section: ManifestProviderSection = {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    schemaVersion: 1,
    artifacts,
    summary: { indexPayloadPath: `${REL}/index.json`, sessionCount: 2 },
  }
  return { section, artifacts }
}

beforeEach(async () => {
  tmp = await makeTempRoot('devmig-claude-merge-')
  home = await createFakeHome(tmp.root, { userName: 'bob' })
  payloadRoot = path.join(tmp.root, 'payload')
  newPath = path.join(home.homeDir, 'Developer', 'demo')
  await fs.mkdir(newPath, { recursive: true })
})
afterEach(async () => {
  await tmp.cleanup()
})

const mapping = () => [{ projectId: PROJECT_ID, oldPath: OLD, newPath }]
const project = () => ({ id: PROJECT_ID, name: 'demo', oldPath: OLD, newPath })
const roots = () => [newPath, home.claudeConfigDir, home.claudeJsonPath]

describe('~/.claude.json merge', () => {
  it('adds entries under the new path, backs up the original, never writes identity keys or MCP env unless selected', async () => {
    const { section, artifacts } = await writePayload()
    const selected = artifacts.filter((a) => !a.id.endsWith('mcp-env'))
    await fs.writeFile(
      home.claudeJsonPath,
      JSON.stringify({
        numStartups: 3,
        userID: 'bob-id',
        oauthAccount: { accountUuid: 'b' },
        projects: { '/Users/bob/other': { allowedTools: ['Read'] } },
      }),
    )
    const input = { project: project(), section, artifacts: selected }
    const plan = await provider.planRestore(input, planningContext(home, payloadRoot, mapping()))
    expect(plan.collisions).toEqual([])
    expect(plan.remap.affected).toEqual(
      expect.arrayContaining([
        { label: 'Claude sessions', count: 2 },
        { label: 'Claude project entries', count: 1 },
      ]),
    )
    expect(plan.remap.safeRewriteCount).toBe(2)
    const result = await provider.restore(
      plan,
      input,
      restoreContext(home, payloadRoot, mapping(), roots()),
    )
    expect(result.status).toBe('ok')
    const json = JSON.parse(await fs.readFile(home.claudeJsonPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(json.numStartups).toBe(3)
    expect(json.userID).toBe('bob-id')
    expect(json.oauthAccount).toEqual({ accountUuid: 'b' })
    const projects = json.projects as Record<string, unknown>
    expect(projects['/Users/bob/other']).toEqual({ allowedTools: ['Read'] })
    expect(projects[newPath]).toEqual({
      allowedTools: ['Bash(git:*)'],
      hasTrustDialogAccepted: true,
      mcpServers: { demo: { type: 'stdio', command: 'npx' } },
    })
    expect(projects[OLD]).toBeUndefined()
    const raw = await fs.readFile(home.claudeJsonPath, 'utf8')
    expect(raw).not.toContain('tok_secret_123')
    const backups = await fs.readdir(path.join(home.claudeConfigDir, 'devmig-backups'))
    expect(backups).toEqual(['claude.json.2026-08-28T10-00-00.000Z.bak'])
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(home.claudeConfigDir, 'devmig-backups', backups[0] as string),
          'utf8',
        ),
      ),
    ).toMatchObject({ numStartups: 3 })
    expect(result.attention?.map((a) => a.id)).toEqual(
      expect.arrayContaining(['reauth', 'mcp-env']),
    )
    expect(result.attention?.find((a) => a.id === 'mcp-env')?.title).toContain('demo')
    const verification = await provider.verify(
      { plan, result, input },
      verifyContext(home, payloadRoot, mapping()),
    )
    expect(verification.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(verification.checks.find((c) => c.id.startsWith('claude-json:'))?.status).toBe('pass')
  })

  it('restores MCP env values only when that artifact is selected', async () => {
    const { section, artifacts } = await writePayload()
    await fs.writeFile(home.claudeJsonPath, '{}')
    const input = { project: project(), section, artifacts }
    const plan = await provider.planRestore(input, planningContext(home, payloadRoot, mapping()))
    expect(plan.steps.some((s) => s.id.endsWith('claude-json-mcp-env'))).toBe(true)
    const result = await provider.restore(
      plan,
      input,
      restoreContext(home, payloadRoot, mapping(), roots()),
    )
    expect(result.status).toBe('ok')
    const json = JSON.parse(await fs.readFile(home.claudeJsonPath, 'utf8')) as {
      projects: Record<string, { mcpServers: Record<string, { env?: Record<string, string> }> }>
    }
    expect(json.projects[newPath]?.mcpServers.demo?.env).toEqual({ DEMO_TOKEN: 'tok_secret_123' })
    expect(result.attention?.some((a) => a.id === 'mcp-env')).toBe(false)
  })

  it('keeps an existing entry by default (skip) and merges add-only when asked', async () => {
    const { section, artifacts } = await writePayload()
    const selected = artifacts.filter((a) => a.id.includes('claude-json:project'))
    await fs.writeFile(
      home.claudeJsonPath,
      JSON.stringify({ projects: { [newPath]: { allowedTools: ['Read'], custom: 1 } } }),
    )
    const input = { project: project(), section, artifacts: selected }
    const plan = await provider.planRestore(input, planningContext(home, payloadRoot, mapping()))
    const collision = plan.collisions.find((c) => c.kind === 'json-entry-exists')
    expect(collision).toMatchObject({
      id: `claude-json:${newPath}`,
      allowedPolicies: ['skip', 'merge'],
      policy: 'skip',
    })
    const skipped = await provider.restore(
      plan,
      input,
      restoreContext(home, payloadRoot, mapping(), roots()),
    )
    expect(skipped.items.find((i) => i.label.includes('project entries'))?.detail).toContain(
      'already present',
    )
    let json = JSON.parse(await fs.readFile(home.claudeJsonPath, 'utf8')) as {
      projects: Record<string, Record<string, unknown>>
    }
    expect(json.projects[newPath]).toEqual({ allowedTools: ['Read'], custom: 1 })
    const verification = await provider.verify(
      { plan, result: skipped, input },
      verifyContext(home, payloadRoot, mapping()),
    )
    expect(verification.checks.find((c) => c.id.startsWith('claude-json:'))).toMatchObject({
      status: 'pass',
      detail: 'present (existing entry kept)',
    })

    const merged = await provider.restore(
      plan,
      input,
      restoreContext(home, payloadRoot, mapping(), roots(), {
        collisionDecisions: { [collision?.id as string]: 'merge' },
      }),
    )
    expect(merged.status).toBe('ok')
    json = JSON.parse(await fs.readFile(home.claudeJsonPath, 'utf8')) as {
      projects: Record<string, Record<string, unknown>>
    }
    expect(json.projects[newPath]).toEqual({
      allowedTools: ['Read'],
      custom: 1,
      hasTrustDialogAccepted: true,
      mcpServers: { demo: { type: 'stdio', command: 'npx' } },
    })
  })

  it('creates ~/.claude.json on a Mac that has none', async () => {
    const { section, artifacts } = await writePayload()
    const selected = artifacts.filter((a) => a.id.includes('claude-json:project'))
    const input = { project: project(), section, artifacts: selected }
    const plan = await provider.planRestore(input, planningContext(home, payloadRoot, mapping()))
    const result = await provider.restore(
      plan,
      input,
      restoreContext(home, payloadRoot, mapping(), roots()),
    )
    expect(result.status).toBe('ok')
    expect(JSON.parse(await fs.readFile(home.claudeJsonPath, 'utf8'))).toMatchObject({
      projects: { [newPath]: { allowedTools: ['Bash(git:*)'] } },
    })
  })
})

describe('session merge', () => {
  it('skips identical transcripts, keeps differing ones as conflict files, and merges memory add-only', async () => {
    const { section, artifacts } = await writePayload()
    const selected = artifacts.filter(
      (a) => a.id.includes(':sessions:') || a.id.includes(':memory:'),
    )
    const input = { project: project(), section, artifacts: selected }
    const first = await provider.planRestore(input, planningContext(home, payloadRoot, mapping()))
    expect(first.collisions).toEqual([])
    const r1 = await provider.restore(
      first,
      input,
      restoreContext(home, payloadRoot, mapping(), roots()),
    )
    expect(r1.status).toBe('ok')
    const destDir = path.join(home.claudeConfigDir, 'projects', encodeProjectDirName(newPath).name)
    const restored = await fs.readFile(path.join(destDir, `${SID}.jsonl`), 'utf8')
    expect(restored).toBe(
      `${JSON.stringify({ type: 'user', cwd: newPath, sessionId: SID, message: { role: 'user', content: `look at ${OLD}/x` } })}\nbroken line\n`,
    )
    await fs.writeFile(path.join(destDir, 'memory', 'MEMORY.md'), '# edited on this Mac\n')

    // second restore: identical -> skipped
    const second = await provider.planRestore(input, planningContext(home, payloadRoot, mapping()))
    expect(second.collisions.map((c) => [c.kind, c.policy, c.allowedPolicies])).toEqual([
      ['claude-project-exists', 'merge', ['merge', 'skip']],
      ['directory-exists', 'merge', ['merge', 'skip']],
    ])
    const r2 = await provider.restore(
      second,
      input,
      restoreContext(home, payloadRoot, mapping(), roots()),
    )
    expect(r2.status).toBe('ok')
    expect(r2.items.find((i) => i.label.startsWith('Sessions'))?.detail).toContain(
      '2 identical skipped',
    )
    expect(r2.warnings).toEqual([])
    expect(await fs.readFile(path.join(destDir, 'memory', 'MEMORY.md'), 'utf8')).toBe(
      '# edited on this Mac\n',
    )
    expect((await fs.readdir(destDir)).filter((f) => f.includes('conflict'))).toEqual([])

    // third restore after the destination transcript diverged -> conflict file + warning
    await fs.appendFile(
      path.join(destDir, `${SID}.jsonl`),
      `${JSON.stringify({ type: 'user', cwd: newPath, sessionId: SID, message: { role: 'user', content: 'continued here' } })}\n`,
    )
    const third = await provider.planRestore(input, planningContext(home, payloadRoot, mapping()))
    const r3 = await provider.restore(
      third,
      input,
      restoreContext(home, payloadRoot, mapping(), roots()),
    )
    expect(r3.warnings.some((w) => w.includes(`${SID}.devmig-conflict.jsonl`))).toBe(true)
    expect(await fs.readFile(path.join(destDir, `${SID}.devmig-conflict.jsonl`), 'utf8')).toBe(
      restored,
    )
    expect((await fs.readdir(destDir)).filter((f) => f.includes('incoming'))).toEqual([])
    const verification = await provider.verify(
      { plan: third, result: r3, input },
      verifyContext(home, payloadRoot, mapping()),
    )
    expect(verification.checks.find((c) => c.id.endsWith(':count'))).toMatchObject({
      status: 'warn',
    })

    // skip policy leaves everything alone
    const r4 = await provider.restore(
      third,
      input,
      restoreContext(home, payloadRoot, mapping(), roots(), {
        collisionDecisions: { [third.collisions[0]?.id as string]: 'skip' },
      }),
    )
    expect(r4.items.find((i) => i.label.startsWith('Sessions'))?.detail).toContain('skipped')
  })
})

describe('project files and ScopedFs boundary', () => {
  it('skips existing project files by default and backs them up on backup-then-replace', async () => {
    const { section, artifacts } = await writePayload()
    const selected = artifacts.filter((a) => a.id.includes('project-file'))
    await fs.writeFile(path.join(newPath, 'CLAUDE.local.md'), 'mine\n')
    const input = { project: project(), section, artifacts: selected }
    const plan = await provider.planRestore(input, planningContext(home, payloadRoot, mapping()))
    expect(plan.collisions).toEqual([
      expect.objectContaining({
        id: 'file:CLAUDE.local.md',
        kind: 'file-exists',
        policy: 'skip',
        allowedPolicies: ['skip', 'backup-then-replace'],
      }),
    ])
    await provider.restore(plan, input, restoreContext(home, payloadRoot, mapping(), roots()))
    expect(await fs.readFile(path.join(newPath, 'CLAUDE.local.md'), 'utf8')).toBe('mine\n')
    await provider.restore(
      plan,
      input,
      restoreContext(home, payloadRoot, mapping(), roots(), {
        collisionDecisions: { 'file:CLAUDE.local.md': 'backup-then-replace' },
      }),
    )
    expect(await fs.readFile(path.join(newPath, 'CLAUDE.local.md'), 'utf8')).toBe('local notes\n')
    expect(
      await fs.readFile(
        path.join(newPath, 'CLAUDE.local.md.devmig-backup-2026-08-28T10-00-00.000Z'),
        'utf8',
      ),
    ).toBe('mine\n')
  })

  it('refuses to write outside the approved roots even with a crafted plan state', async () => {
    const { section, artifacts } = await writePayload()
    const selected = artifacts.filter(
      (a) => a.id.includes(':sessions:') || a.id.includes('project-file'),
    )
    const input = { project: project(), section, artifacts: selected }
    const plan = await provider.planRestore(input, planningContext(home, payloadRoot, mapping()))
    const outside = path.join(tmp.root, 'outside')
    const state = plan.state as {
      sessions: { destDir: string }[]
      projectFiles: { dest: string }[]
    }
    state.sessions[0]!.destDir = path.join(outside, 'projects', 'x')
    state.projectFiles[0]!.dest = path.join(outside, 'CLAUDE.local.md')
    const result = await provider.restore(
      plan,
      input,
      restoreContext(home, payloadRoot, mapping(), roots()),
    )
    expect(result.status).toBe('failed')
    expect(
      result.items.every(
        (i) => i.status === 'error' && /outside the approved destination/.test(i.detail ?? ''),
      ),
    ).toBe(true)
    await expect(fs.stat(outside)).rejects.toThrow()
  })

  it('rejects unsafe payload paths from the manifest', async () => {
    const { section, artifacts } = await writePayload()
    const evil = { ...(artifacts[0] as ManifestArtifact), payloadPath: '../../etc' }
    const input = { project: project(), section, artifacts: [evil] }
    await expect(
      provider.planRestore(input, planningContext(home, payloadRoot, mapping())),
    ).rejects.toMatchObject({ code: 'ARCHIVE_ENTRY_REJECTED' })
  })
})
