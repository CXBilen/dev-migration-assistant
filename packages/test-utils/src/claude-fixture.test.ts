import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeClaudeProjectDir } from './claude-encoding'
import {
  FIXTURE_CLAUDE_VERSION,
  FIXTURE_FILE_HISTORY_BLOBS,
  FIXTURE_MCP_SECRET,
  buildClaudeTranscript,
  createClaudeFixture,
  type ClaudeFixture,
} from './claude-fixture'
import { createFakeHome } from './fake-home'
import { isUuidV4 } from './ids'
import { readJsonl } from './jsonl'
import { withTempRoot } from './temp'

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false)
}

async function build(root: string, extra: Partial<Parameters<typeof createClaudeFixture>[0]> = {}) {
  const home = await createFakeHome(root, { userName: 'alice' })
  const projectPath = path.join(home.projectsDir, 'demo')
  const worktreePath = path.join(home.projectsDir, 'demo-onboarding')
  await fs.mkdir(worktreePath, { recursive: true })
  const fixture = await createClaudeFixture({
    claudeConfigDir: home.claudeConfigDir,
    claudeJsonPath: home.claudeJsonPath,
    projectPath,
    worktreePaths: [{ path: worktreePath, branch: 'feature/onboarding' }],
    ...extra,
  })
  return { home, projectPath, worktreePath, fixture }
}

describe('createClaudeFixture', () => {
  it('writes the documented ~/.claude layout for the project, its worktrees and an unrelated project', async () => {
    await withTempRoot(async (root) => {
      const { home, projectPath, worktreePath, fixture } = await build(root)
      const enc = encodeClaudeProjectDir(projectPath)
      expect(fixture.encoded.project).toBe(enc)
      expect(fixture.projectDir).toBe(path.join(home.claudeConfigDir, 'projects', enc))
      expect(fixture.encoded.orphanWorktree).toBe(
        encodeClaudeProjectDir(`${projectPath}/.claude/worktrees/onboarding`),
      )
      expect(fixture.encoded.orphanWorktree.endsWith('-demo--claude-worktrees-onboarding')).toBe(
        true,
      )
      expect(fixture.encoded.worktrees[worktreePath]).toBe(encodeClaudeProjectDir(worktreePath))
      expect(fixture.version).toBe(FIXTURE_CLAUDE_VERSION)

      // Sessions: 3 project + 1 worktree + 1 orphan + 1 other.
      expect(fixture.sessions.map((s) => s.kind)).toEqual([
        'project',
        'project',
        'project',
        'worktree',
        'orphan-worktree',
        'other-project',
      ])
      expect(fixture.projectSessionIds).toHaveLength(3)
      expect(fixture.expectedProjectSessionIds).toHaveLength(5)
      expect(fixture.otherSessionIds).toHaveLength(1)
      expect(new Set(fixture.sessions.map((s) => s.id)).size).toBe(6)
      for (const s of fixture.sessions) {
        expect(isUuidV4(s.id)).toBe(true)
        expect(s.transcriptPath).toBe(path.join(s.projectDir, `${s.id}.jsonl`))
        expect(s.projectDirName).toBe(encodeClaudeProjectDir(s.cwd))
        for (const p of [
          s.transcriptPath,
          s.toolResultPath,
          s.subagentTranscriptPath,
          s.sessionEnvScript,
          ...s.fileHistoryFiles,
        ]) {
          expect(await exists(p), p).toBe(true)
        }
        expect(s.toolResultPath).toBe(path.join(s.sessionDir, 'tool-results', 'result-1.txt'))
        expect(s.subagentTranscriptPath).toBe(path.join(s.sessionDir, 'subagents', 'agent-1.jsonl'))
        expect(s.fileHistoryDir).toBe(path.join(home.claudeConfigDir, 'file-history', s.id))
        expect(s.fileHistoryFiles.map((f) => path.basename(f))).toEqual([
          FIXTURE_FILE_HISTORY_BLOBS.indexTs,
          FIXTURE_FILE_HISTORY_BLOBS.readme,
        ])
        expect(s.sessionEnvScript).toBe(
          path.join(home.claudeConfigDir, 'session-env', s.id, 'sessionstart-hook-1.sh'),
        )
      }

      // The orphan worktree dir must not exist on disk; the sibling worktree does.
      expect(await exists(fixture.orphanWorktreePath)).toBe(false)
      expect(await exists(worktreePath)).toBe(true)
      expect(await exists(fixture.orphanWorktreeProjectDir)).toBe(true)
      expect(await exists(fixture.otherProjectDir)).toBe(true)
      expect(await exists(fixture.otherProjectPath)).toBe(false)

      // Auto memory only under the repo-root project dir.
      expect(fixture.files.memoryDir).toBe(path.join(fixture.projectDir, 'memory'))
      expect(await exists(fixture.files.memoryIndex)).toBe(true)
      expect(await exists(fixture.files.memoryNotes)).toBe(true)
      expect(await exists(path.join(fixture.orphanWorktreeProjectDir, 'memory'))).toBe(false)
      expect(await fs.readFile(fixture.files.memoryNotes, 'utf8')).toContain(projectPath)

      // User-scope files.
      for (const p of Object.values<string>({ ...fixture.files }))
        expect(await exists(p), p).toBe(true)
      expect(fixture.files.skillMd).toBe(
        path.join(home.claudeConfigDir, 'skills', 'demo-skill', 'SKILL.md'),
      )
      expect(fixture.files.agentMd).toBe(path.join(home.claudeConfigDir, 'agents', 'reviewer.md'))
      expect(JSON.parse(await fs.readFile(fixture.files.settingsJson, 'utf8'))).toMatchObject({
        model: 'opus',
        cleanupPeriodDays: 90,
      })
      expect(JSON.parse(await fs.readFile(fixture.files.settingsLocalJson, 'utf8'))).toEqual({})
      expect(JSON.parse(await fs.readFile(fixture.files.installedPluginsJson, 'utf8'))).toEqual({
        version: 2,
        plugins: {},
      })
      expect(JSON.parse(await fs.readFile(fixture.files.knownMarketplacesJson, 'utf8'))).toEqual({})
      expect(fixture.files.sessionsRegistry).toBe(
        path.join(home.claudeConfigDir, 'sessions', '12345.json'),
      )
      expect(fixture.files.sessionsKey).toBe(
        path.join(home.claudeConfigDir, 'sessions', '12345.abc.key'),
      )
      expect(fixture.files.shellSnapshot).toBe(
        path.join(home.claudeConfigDir, 'shell-snapshots', 'snapshot-zsh-1.sh'),
      )
      expect(fixture.ephemeralPaths).toEqual(
        expect.arrayContaining([fixture.files.sessionsRegistry, fixture.files.sessionsKey]),
      )

      // Project-side files.
      const pf = fixture.projectFiles
      expect(pf).toBeDefined()
      if (!pf) return
      expect(pf.settingsLocalJson).toBe(path.join(projectPath, '.claude', 'settings.local.json'))
      expect(JSON.parse(await fs.readFile(pf.settingsLocalJson, 'utf8'))).toEqual({
        permissions: { allow: ['Bash(pnpm test)'] },
      })
      expect(JSON.parse(await fs.readFile(pf.mcpJson, 'utf8'))).toEqual({
        mcpServers: { shared: { type: 'http', url: 'https://example.com/mcp' } },
      })
      expect(await fs.readFile(pf.nvmrc, 'utf8')).toBe('22\n')
      expect(await exists(pf.claudeMd)).toBe(true)
      expect(await exists(pf.claudeLocalMd)).toBe(true)
    })
  })

  it('writes transcripts that parse tolerantly, carry the real record schema and keep the old path in prose', async () => {
    await withTempRoot(async (root) => {
      const { home, projectPath, fixture } = await build(root)
      const session = fixture.sessions[0]
      expect(session).toBeDefined()
      if (!session) return
      const { records, invalidLines } = await readJsonl(session.transcriptPath)
      expect(records).toHaveLength(session.recordCount)
      expect(records).toHaveLength(8)
      expect(invalidLines).toEqual([{ lineNumber: 9, text: 'not json' }])
      expect(records.map((r) => r.type)).toEqual([
        'custom-title',
        'user',
        'assistant',
        'user',
        'file-history-snapshot',
        'file-history-delta',
        'last-prompt',
        'permission-mode',
      ])
      const [title, user, assistant, toolResult, snapshot, delta, lastPrompt, mode] = records
      expect(title).toEqual({
        type: 'custom-title',
        customTitle: session.customTitle,
        sessionId: session.id,
      })
      expect(user).toMatchObject({
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        cwd: projectPath,
        sessionId: session.id,
        version: '2.1.247',
        gitBranch: 'main',
        entrypoint: 'cli',
        type: 'user',
        message: { role: 'user' },
        uuid: session.messageUuids[0],
      })
      expect(typeof user?.timestamp).toBe('string')
      expect(isUuidV4(String(user?.uuid))).toBe(true)
      expect(assistant).toMatchObject({
        parentUuid: session.messageUuids[0],
        cwd: projectPath,
        type: 'assistant',
        uuid: session.messageUuids[1],
        message: { role: 'assistant' },
      })
      const content = (
        assistant?.message as {
          content: { type: string; text?: string; input?: { file_path?: string } }[]
        }
      ).content
      expect(content[0]?.type).toBe('text')
      expect(content[0]?.text).toContain(`I looked at ${projectPath}/src/index.ts`)
      expect(content[1]).toMatchObject({
        type: 'tool_use',
        name: 'Read',
        input: { file_path: `${projectPath}/README.md` },
      })
      expect(toolResult).toMatchObject({
        type: 'user',
        parentUuid: session.messageUuids[1],
        uuid: session.messageUuids[2],
        toolUseResult: {
          filePath: `${projectPath}/README.md`,
          transcriptDir: path.join(home.claudeConfigDir, 'projects', fixture.encoded.project),
        },
      })
      expect(snapshot).toEqual({
        type: 'file-history-snapshot',
        messageId: session.messageUuids[0],
        isSnapshotUpdate: false,
        snapshot: {
          messageId: session.messageUuids[0],
          trackedFileBackups: {
            'src/index.ts': {
              backupFileName: 'abc123@v1',
              version: 1,
              backupTime: expect.any(String) as string,
              realParentDir: projectPath,
            },
          },
          timestamp: expect.any(String) as string,
        },
      })
      expect(delta).toEqual({
        type: 'file-history-delta',
        messageId: session.messageUuids[2],
        snapshotMessageId: session.messageUuids[0],
        timestamp: expect.any(String) as string,
        trackingPath: 'README.md',
        backup: {
          backupFileName: 'def456@v1',
          version: 1,
          backupTime: expect.any(String) as string,
          realParentDir: projectPath,
        },
      })
      expect(lastPrompt).toMatchObject({
        type: 'last-prompt',
        leafUuid: session.messageUuids[2],
        sessionId: session.id,
      })
      expect(mode).toEqual({
        type: 'permission-mode',
        permissionMode: 'default',
        sessionId: session.id,
      })

      // Subagent transcript: sidechain records with the same cwd.
      const sub = await readJsonl(session.subagentTranscriptPath)
      expect(sub.invalidLines).toEqual([])
      expect(sub.records).toHaveLength(2)
      expect(sub.records[0]).toMatchObject({
        isSidechain: true,
        cwd: projectPath,
        sessionId: session.id,
      })
    })
  })

  it('gives worktree and orphan sessions their own cwd/branch and keeps the other project unrelated', async () => {
    await withTempRoot(async (root) => {
      const { projectPath, worktreePath, fixture } = await build(root)
      const wt = fixture.sessions.find((s) => s.kind === 'worktree')
      const orphan = fixture.sessions.find((s) => s.kind === 'orphan-worktree')
      const other = fixture.sessions.find((s) => s.kind === 'other-project')
      expect(wt).toMatchObject({
        cwd: worktreePath,
        gitBranch: 'feature/onboarding',
        expectedMatch: 'strong',
      })
      expect(orphan).toMatchObject({
        cwd: `${projectPath}/.claude/worktrees/onboarding`,
        gitBranch: 'worktree-onboarding',
        expectedMatch: 'strong',
      })
      expect(other).toMatchObject({ cwd: fixture.otherProjectPath, expectedMatch: 'none' })
      if (!wt || !orphan || !other) return
      for (const s of [wt, orphan, other]) {
        const { records } = await readJsonl(s.transcriptPath)
        const messages = records.filter((r) => r.type === 'user' || r.type === 'assistant')
        expect(messages.length).toBeGreaterThan(0)
        for (const m of messages) {
          expect(m.cwd).toBe(s.cwd)
          expect(m.gitBranch).toBe(s.gitBranch)
        }
      }
      expect(path.dirname(other.transcriptPath)).toBe(fixture.otherProjectDir)
      expect(fixture.otherProjectDir).not.toBe(fixture.projectDir)
    })
  })

  it('writes history.jsonl rows and ~/.claude.json with the documented shape', async () => {
    await withTempRoot(async (root) => {
      const { projectPath, worktreePath, fixture } = await build(root)
      const history = await readJsonl(fixture.files.historyJsonl)
      expect(history.invalidLines).toEqual([])
      expect(history.records).toHaveLength(5)
      expect(history.records).toEqual(fixture.historyRows)
      expect(history.records.filter((r) => r.project === projectPath)).toHaveLength(3)
      expect(history.records.filter((r) => r.project === fixture.otherProjectPath)).toHaveLength(2)
      for (const row of history.records) {
        expect(Object.keys(row).sort()).toEqual([
          'display',
          'pastedContents',
          'project',
          'sessionId',
          'timestamp',
        ])
        expect(typeof row.timestamp).toBe('number')
        expect(row.pastedContents).toEqual({})
      }
      const timestamps = history.records.map((r) => r.timestamp as number)
      expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps)
      for (const row of history.records.filter((r) => r.project === projectPath)) {
        expect(fixture.projectSessionIds).toContain(row.sessionId)
      }

      const claudeJson = JSON.parse(await fs.readFile(fixture.claudeJsonPath, 'utf8')) as Record<
        string,
        unknown
      >
      expect(claudeJson).toMatchObject({
        numStartups: 5,
        userID: 'u-fake',
        machineID: 'm-fake',
        oauthAccount: { accountUuid: 'fake', emailAddress: 'alice@example.com' },
      })
      const projects = claudeJson.projects as Record<string, Record<string, unknown>>
      expect(Object.keys(projects).sort()).toEqual(
        [projectPath, fixture.orphanWorktreePath, fixture.otherProjectPath, worktreePath].sort(),
      )
      expect(projects[projectPath]).toEqual({
        allowedTools: ['Bash(git:*)'],
        hasTrustDialogAccepted: true,
        mcpServers: {
          demo: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'demo-mcp'],
            env: { DEMO_TOKEN: FIXTURE_MCP_SECRET },
          },
        },
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        lastSessionId: fixture.projectSessionIds[0],
      })
      expect(projects[fixture.orphanWorktreePath]).toEqual({
        allowedTools: [],
        hasTrustDialogAccepted: true,
      })
      expect(projects[fixture.otherProjectPath]).toEqual({
        allowedTools: [],
        hasTrustDialogAccepted: true,
      })
      expect(fixture.secrets).toContain(FIXTURE_MCP_SECRET)
    })
  })

  it('is deterministic for the same paths and honours sessionCount / includeOrphanWorktreeSession / createProjectFiles', async () => {
    await withTempRoot(async (root) => {
      const a = await build(root)
      const first = a.fixture.sessions[0]
      if (!first) throw new Error('no session')
      const transcriptA = await fs.readFile(first.transcriptPath, 'utf8')
      await fs.rm(a.home.claudeConfigDir, { recursive: true, force: true })
      const b = await build(root)
      expect(b.fixture.sessions.map((s) => s.id)).toEqual(a.fixture.sessions.map((s) => s.id))
      expect(await fs.readFile(first.transcriptPath, 'utf8')).toBe(transcriptA)

      await fs.rm(b.home.claudeConfigDir, { recursive: true, force: true })
      const c = await build(root, {
        sessionCount: 1,
        includeOrphanWorktreeSession: false,
        createProjectFiles: false,
        worktreePaths: [],
      })
      expect(c.fixture.sessions.map((s) => s.kind)).toEqual(['project', 'other-project'])
      expect(c.fixture.projectFiles).toBeUndefined()
      expect(await exists(c.fixture.orphanWorktreeProjectDir)).toBe(false)
      // ~/.claude.json still lists the stale worktree entry (realistic leftover).
      const claudeJson = JSON.parse(await fs.readFile(c.fixture.claudeJsonPath, 'utf8')) as {
        projects: Record<string, unknown>
      }
      expect(Object.keys(claudeJson.projects)).toContain(c.fixture.orphanWorktreePath)
    })
  })

  it('rejects invalid options and unsafe locations', async () => {
    await withTempRoot(async (root) => {
      const home = await createFakeHome(root)
      const base = {
        claudeConfigDir: home.claudeConfigDir,
        claudeJsonPath: home.claudeJsonPath,
        projectPath: path.join(home.projectsDir, 'demo'),
      }
      await expect(createClaudeFixture({ ...base, sessionCount: 0 })).rejects.toThrow()
      await expect(
        createClaudeFixture({ ...base, otherProjectPath: base.projectPath }),
      ).rejects.toThrow()
      await expect(createClaudeFixture({ ...base, projectPath: 'relative' })).rejects.toThrow()
      await expect(
        createClaudeFixture({
          ...base,
          claudeConfigDir: path.join(process.env.HOME ?? '/nonexistent', '.claude'),
        }),
      ).rejects.toThrow()
    })
  })
})

describe('buildClaudeTranscript', () => {
  it('builds the record list without touching the filesystem', () => {
    const t = buildClaudeTranscript({
      sessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
      cwd: '/tmp/p',
      gitBranch: 'main',
      ordinal: 7,
      transcriptDir: '/tmp/claude/projects/-tmp-p',
    })
    expect(t.lines).toHaveLength(9)
    expect(t.lines[t.lines.length - 1]).toBe('not json')
    expect(t.recordCount).toBe(8)
    expect(t.uuids.every(isUuidV4)).toBe(true)
    expect(t.lines.slice(0, 8).every((l) => typeof JSON.parse(l) === 'object')).toBe(true)
  })
})

// Keep the type import used so the public shape stays covered by tsc.
export type _ClaudeFixtureShape = ClaudeFixture
