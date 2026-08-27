/**
 * Fake `~/.claude` + `~/.claude.json` builder mirroring the layout and record shapes observed on a
 * real Claude Code 2.1.247 install (docs/research/claude-code-storage.md §2–§14). Everything is
 * deterministic: session ids are seeded UUID v4 strings, timestamps are fixed, contents are small.
 * No real usernames, no real secrets — the "secrets" are obvious placeholders listed in `secrets`.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MigrationError } from '@devmig/shared'
import { encodeClaudeProjectDir } from './claude-encoding'
import { deterministicUuid } from './ids'
import { writeJsonlLines } from './jsonl'
import { assertSafeFixtureRoot } from './temp'

export const FIXTURE_CLAUDE_VERSION = '2.1.247'
export const FIXTURE_CLAUDE_MODEL = 'claude-opus-4-1'
export const FIXTURE_ORPHAN_WORKTREE_NAME = 'onboarding'
/** Fake MCP token placed in ~/.claude.json projects[project].mcpServers.demo.env. */
export const FIXTURE_MCP_SECRET = 'tok_secret_123'
/** Fake live-session peer token written to sessions/12345.abc.key (ephemeral, must never be migrated). */
export const FIXTURE_SESSION_KEY_TOKEN = 'fixture-peer-token-0123456789abcdef'
export const FIXTURE_FILE_HISTORY_BLOBS = { indexTs: 'abc123@v1', readme: 'def456@v1' } as const
export const FIXTURE_LIVE_SESSION_PID = 12345
export const FIXTURE_USER_PROMPT = 'Please look at src/index.ts and summarise what it exports.'

/** Base timestamp of the first record of the first session (UTC). */
const BASE_TIME_MS = Date.UTC(2026, 7, 20, 10, 0, 0)
const SESSION_SPACING_MS = 60 * 60 * 1000
const RECORD_SPACING_MS = 60 * 1000

export type ClaudeSessionKind = 'project' | 'orphan-worktree' | 'worktree' | 'other-project'

export interface ClaudeWorktreeSpec {
  /** Absolute path of an existing linked worktree of projectPath. */
  path: string
  /** gitBranch recorded in that worktree's session (default "feature/<basename>"). */
  branch?: string
}

export interface ClaudeFixtureOptions {
  /** The fake `~/.claude` (must not be the real one). */
  claudeConfigDir: string
  /** The fake `~/.claude.json`. */
  claudeJsonPath: string
  /** Absolute project path the sessions ran in. Created on disk when missing. */
  projectPath: string
  /** Existing sibling worktrees that get one session each (cwd = worktree path). */
  worktreePaths?: ReadonlyArray<string | ClaudeWorktreeSpec>
  /** Sessions whose cwd is projectPath (default 3, min 1). */
  sessionCount?: number
  /**
   * Also write a session under projects/<encode(projectPath + "/.claude/worktrees/onboarding")>
   * whose worktree directory does not exist on disk (default true — realistic leftovers).
   */
  includeOrphanWorktreeSession?: boolean
  /** Unrelated project that must never be matched (default "<dirname(projectPath)>/unrelated-project"). Not created on disk. */
  otherProjectPath?: string
  /** Write <projectPath>/CLAUDE.md, CLAUDE.local.md, .mcp.json, .nvmrc, .claude/settings.local.json (default true). */
  createProjectFiles?: boolean
}

export interface ClaudeSessionFixture {
  id: string
  kind: ClaudeSessionKind
  /** `cwd` recorded on every message record. */
  cwd: string
  gitBranch: string
  /** Name of the projects/<dir> directory holding the transcript (encodeClaudeProjectDir(cwd)). */
  projectDirName: string
  /** Absolute path of projects/<dir>. */
  projectDir: string
  transcriptPath: string
  /** projects/<dir>/<id>/ */
  sessionDir: string
  toolResultPath: string
  subagentTranscriptPath: string
  /** file-history/<id>/ */
  fileHistoryDir: string
  fileHistoryFiles: string[]
  /** session-env/<id>/ (ephemeral) */
  sessionEnvDir: string
  sessionEnvScript: string
  customTitle: string
  /** uuids of the three message records in order (user, assistant, user tool-result). */
  messageUuids: [string, string, string]
  /** Valid JSON records in the transcript (the unparseable line is not counted). */
  recordCount: number
  invalidLineCount: number
  /** How a metadata-driven resolver (ADR-0004) should classify this session for projectPath. */
  expectedMatch: 'exact' | 'strong' | 'none'
}

export interface ClaudeHistoryRow {
  display: string
  pastedContents: Record<string, never>
  /** Unix epoch milliseconds. */
  timestamp: number
  project: string
  sessionId: string
}

export interface ClaudeFixtureFiles {
  settingsJson: string
  settingsLocalJson: string
  claudeMd: string
  statuslineScript: string
  skillMd: string
  agentMd: string
  installedPluginsJson: string
  knownMarketplacesJson: string
  historyJsonl: string
  memoryDir: string
  memoryIndex: string
  memoryNotes: string
  /** sessions/12345.json — live registry entry (ephemeral). */
  sessionsRegistry: string
  /** sessions/12345.abc.key — peer token (ephemeral credential). */
  sessionsKey: string
  shellSnapshot: string
}

export interface ClaudeProjectFiles {
  claudeDir: string
  settingsLocalJson: string
  claudeLocalMd: string
  claudeMd: string
  mcpJson: string
  nvmrc: string
}

export interface ClaudeFixture {
  claudeConfigDir: string
  claudeJsonPath: string
  projectPath: string
  otherProjectPath: string
  /** projectPath + "/.claude/worktrees/onboarding" (never created on disk). */
  orphanWorktreePath: string
  version: typeof FIXTURE_CLAUDE_VERSION
  /** <claudeConfigDir>/projects */
  projectsDir: string
  /** Encoded directory names. */
  encoded: {
    project: string
    orphanWorktree: string
    otherProject: string
    /** worktree path -> encoded name */
    worktrees: Record<string, string>
  }
  /** <claudeConfigDir>/projects/<encoded.project> */
  projectDir: string
  orphanWorktreeProjectDir: string
  otherProjectDir: string
  sessions: ClaudeSessionFixture[]
  /** Sessions with cwd === projectPath. */
  projectSessionIds: string[]
  /** Every session a resolver should attribute to projectPath (project + worktrees + orphan worktree). */
  expectedProjectSessionIds: string[]
  /** Sessions that must NOT be attributed to projectPath. */
  otherSessionIds: string[]
  historyRows: ClaudeHistoryRow[]
  files: ClaudeFixtureFiles
  /** Project-side files (undefined when createProjectFiles is false). */
  projectFiles?: ClaudeProjectFiles
  /** Placeholder secrets planted in the fixture; assert they never leak into logs/manifests. */
  secrets: string[]
  /** Paths a backup must classify as ephemeral / never migrate. */
  ephemeralPaths: string[]
}

interface SessionSpec {
  kind: ClaudeSessionKind
  cwd: string
  gitBranch: string
  /** Ordinal used for timestamps and titles. */
  ordinal: number
  id: string
  expectedMatch: ClaudeSessionFixture['expectedMatch']
}

function isoAt(sessionOrdinal: number, recordIndex: number): string {
  return new Date(
    BASE_TIME_MS + sessionOrdinal * SESSION_SPACING_MS + recordIndex * RECORD_SPACING_MS,
  ).toISOString()
}

function msAt(sessionOrdinal: number, recordIndex: number): number {
  return BASE_TIME_MS + sessionOrdinal * SESSION_SPACING_MS + recordIndex * RECORD_SPACING_MS
}

async function writeText(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`)
}

function assertAbsolute(p: string, label: string): string {
  if (typeof p !== 'string' || p.length === 0 || !path.isAbsolute(p) || p.includes('\0')) {
    throw new MigrationError('INVALID_INPUT', `${label} must be an absolute path`)
  }
  return path.resolve(p)
}

/** The transcript records of one session, in the documented order, plus the deliberately broken line. */
export function buildClaudeTranscript(input: {
  sessionId: string
  cwd: string
  gitBranch: string
  ordinal: number
  transcriptDir: string
  version?: string
}): { lines: string[]; uuids: [string, string, string]; recordCount: number } {
  const { sessionId, cwd, gitBranch, ordinal, transcriptDir } = input
  const version = input.version ?? FIXTURE_CLAUDE_VERSION
  const uuid = (i: number): string => deterministicUuid(`claude-message:${sessionId}`, i)
  const u1 = uuid(1)
  const u2 = uuid(2)
  const u3 = uuid(3)
  const toolUseId = `toolu_fixture_${String(ordinal).padStart(4, '0')}_1`
  const common = {
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId,
    version,
    gitBranch,
    entrypoint: 'cli',
  }
  const records: unknown[] = [
    { type: 'custom-title', customTitle: `Fixture session ${ordinal}`, sessionId },
    {
      parentUuid: null,
      ...common,
      type: 'user',
      message: { role: 'user', content: FIXTURE_USER_PROMPT },
      uuid: u1,
      timestamp: isoAt(ordinal, 1),
    },
    {
      parentUuid: u1,
      ...common,
      type: 'assistant',
      message: {
        id: `msg_fixture_${String(ordinal).padStart(4, '0')}_1`,
        type: 'message',
        role: 'assistant',
        model: FIXTURE_CLAUDE_MODEL,
        content: [
          // Prose that contains the absolute path on purpose: it must survive remap untouched (ADR-0005).
          {
            type: 'text',
            text: `I looked at ${cwd}/src/index.ts and it exports a single constant.`,
          },
          // Tool input is conversation content too: never rewritten.
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Read',
            input: { file_path: `${cwd}/README.md` },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 48 },
      },
      requestId: `req_fixture_${String(ordinal).padStart(4, '0')}_1`,
      uuid: u2,
      timestamp: isoAt(ordinal, 2),
    },
    {
      parentUuid: u2,
      ...common,
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: toolUseId, type: 'tool_result', content: '     1→# demo\n' }],
      },
      // Structured, schema-owned path fields: these ARE remapped.
      toolUseResult: {
        type: 'text',
        filePath: `${cwd}/README.md`,
        file: {
          filePath: `${cwd}/README.md`,
          content: '# demo\n',
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
        transcriptDir,
      },
      uuid: u3,
      timestamp: isoAt(ordinal, 3),
    },
    {
      type: 'file-history-snapshot',
      messageId: u1,
      isSnapshotUpdate: false,
      snapshot: {
        messageId: u1,
        trackedFileBackups: {
          'src/index.ts': {
            backupFileName: FIXTURE_FILE_HISTORY_BLOBS.indexTs,
            version: 1,
            backupTime: isoAt(ordinal, 1),
            realParentDir: cwd,
          },
        },
        timestamp: isoAt(ordinal, 1),
      },
    },
    {
      type: 'file-history-delta',
      messageId: u3,
      snapshotMessageId: u1,
      timestamp: isoAt(ordinal, 3),
      trackingPath: 'README.md',
      backup: {
        backupFileName: FIXTURE_FILE_HISTORY_BLOBS.readme,
        version: 1,
        backupTime: isoAt(ordinal, 3),
        realParentDir: cwd,
      },
    },
    { type: 'last-prompt', lastPrompt: FIXTURE_USER_PROMPT, leafUuid: u3, sessionId },
    { type: 'permission-mode', permissionMode: 'default', sessionId },
  ]
  const lines = records.map((r) => JSON.stringify(r))
  lines.push('not json')
  return { lines, uuids: [u1, u2, u3], recordCount: records.length }
}

function buildSubagentTranscript(input: {
  sessionId: string
  cwd: string
  gitBranch: string
  ordinal: number
}): string[] {
  const { sessionId, cwd, gitBranch, ordinal } = input
  const a1 = deterministicUuid(`claude-subagent:${sessionId}`, 1)
  const a2 = deterministicUuid(`claude-subagent:${sessionId}`, 2)
  const common = {
    isSidechain: true,
    userType: 'external',
    cwd,
    sessionId,
    version: FIXTURE_CLAUDE_VERSION,
    gitBranch,
    entrypoint: 'cli',
  }
  return [
    {
      parentUuid: null,
      ...common,
      type: 'user',
      message: { role: 'user', content: 'Review the changes in src/index.ts.' },
      uuid: a1,
      timestamp: isoAt(ordinal, 4),
    },
    {
      parentUuid: a1,
      ...common,
      type: 'assistant',
      message: {
        id: `msg_fixture_${String(ordinal).padStart(4, '0')}_agent`,
        type: 'message',
        role: 'assistant',
        model: FIXTURE_CLAUDE_MODEL,
        content: [{ type: 'text', text: `Reviewed ${cwd}/src/index.ts: no issues found.` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 60, output_tokens: 12 },
      },
      uuid: a2,
      timestamp: isoAt(ordinal, 5),
    },
  ].map((r) => JSON.stringify(r))
}

async function writeSession(
  claudeConfigDir: string,
  spec: SessionSpec,
): Promise<ClaudeSessionFixture> {
  const projectDirName = encodeClaudeProjectDir(spec.cwd)
  const projectDir = path.join(claudeConfigDir, 'projects', projectDirName)
  const transcriptPath = path.join(projectDir, `${spec.id}.jsonl`)
  const sessionDir = path.join(projectDir, spec.id)
  const toolResultPath = path.join(sessionDir, 'tool-results', 'result-1.txt')
  const subagentTranscriptPath = path.join(sessionDir, 'subagents', 'agent-1.jsonl')
  const fileHistoryDir = path.join(claudeConfigDir, 'file-history', spec.id)
  const sessionEnvDir = path.join(claudeConfigDir, 'session-env', spec.id)
  const sessionEnvScript = path.join(sessionEnvDir, 'sessionstart-hook-1.sh')

  const transcript = buildClaudeTranscript({
    sessionId: spec.id,
    cwd: spec.cwd,
    gitBranch: spec.gitBranch,
    ordinal: spec.ordinal,
    transcriptDir: projectDir,
  })
  await writeJsonlLines(transcriptPath, transcript.lines)
  await writeText(
    toolResultPath,
    `Persisted tool output for session ${spec.id}\n${spec.cwd}/src/index.ts:1: export const greeting = 'hello'\n`,
  )
  await writeJsonlLines(
    subagentTranscriptPath,
    buildSubagentTranscript({
      sessionId: spec.id,
      cwd: spec.cwd,
      gitBranch: spec.gitBranch,
      ordinal: spec.ordinal,
    }),
  )
  const blobIndex = path.join(fileHistoryDir, FIXTURE_FILE_HISTORY_BLOBS.indexTs)
  const blobReadme = path.join(fileHistoryDir, FIXTURE_FILE_HISTORY_BLOBS.readme)
  await writeText(blobIndex, "export const greeting = 'hello'\n")
  await writeText(blobReadme, '# demo\n')
  await writeText(sessionEnvScript, 'export FIXTURE_HOOK_HINT=1\n')

  return {
    id: spec.id,
    kind: spec.kind,
    cwd: spec.cwd,
    gitBranch: spec.gitBranch,
    projectDirName,
    projectDir,
    transcriptPath,
    sessionDir,
    toolResultPath,
    subagentTranscriptPath,
    fileHistoryDir,
    fileHistoryFiles: [blobIndex, blobReadme],
    sessionEnvDir,
    sessionEnvScript,
    customTitle: `Fixture session ${spec.ordinal}`,
    messageUuids: transcript.uuids,
    recordCount: transcript.recordCount,
    invalidLineCount: 1,
    expectedMatch: spec.expectedMatch,
  }
}

function normalizeWorktrees(
  input: ReadonlyArray<string | ClaudeWorktreeSpec> | undefined,
): { path: string; branch: string }[] {
  return (input ?? []).map((w) => {
    const raw = typeof w === 'string' ? { path: w } : w
    const p = assertAbsolute(raw.path, 'worktree path')
    return { path: p, branch: raw.branch ?? `feature/${path.basename(p)}` }
  })
}

/**
 * Writes a realistic fake Claude Code state for one project (plus an unrelated project and an
 * orphaned worktree session) and returns every path a test could need.
 */
export async function createClaudeFixture(opts: ClaudeFixtureOptions): Promise<ClaudeFixture> {
  const claudeConfigDir = assertSafeFixtureRoot(
    assertAbsolute(opts.claudeConfigDir, 'claudeConfigDir'),
  )
  const claudeJsonPath = assertAbsolute(opts.claudeJsonPath, 'claudeJsonPath')
  assertSafeFixtureRoot(path.dirname(claudeJsonPath))
  const projectPath = assertSafeFixtureRoot(assertAbsolute(opts.projectPath, 'projectPath'))
  const otherProjectPath = assertAbsolute(
    opts.otherProjectPath ?? path.join(path.dirname(projectPath), 'unrelated-project'),
    'otherProjectPath',
  )
  if (otherProjectPath === projectPath) {
    throw new MigrationError('INVALID_INPUT', 'otherProjectPath must differ from projectPath')
  }
  const sessionCount = opts.sessionCount ?? 3
  if (!Number.isInteger(sessionCount) || sessionCount < 1 || sessionCount > 500) {
    throw new MigrationError('INVALID_INPUT', `sessionCount must be an integer in 1..500`)
  }
  const includeOrphan = opts.includeOrphanWorktreeSession ?? true
  const createProjectFiles = opts.createProjectFiles ?? true
  const worktrees = normalizeWorktrees(opts.worktreePaths)
  const orphanWorktreePath = path.join(
    projectPath,
    '.claude',
    'worktrees',
    FIXTURE_ORPHAN_WORKTREE_NAME,
  )

  await fs.mkdir(claudeConfigDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(projectPath, { recursive: true })

  // ---- sessions ----
  const specs: SessionSpec[] = []
  let ordinal = 1
  for (let i = 1; i <= sessionCount; i += 1) {
    specs.push({
      kind: 'project',
      cwd: projectPath,
      gitBranch: 'main',
      ordinal: ordinal++,
      id: deterministicUuid(`claude-session:${projectPath}`, i),
      expectedMatch: 'exact',
    })
  }
  for (const wt of worktrees) {
    specs.push({
      kind: 'worktree',
      cwd: wt.path,
      gitBranch: wt.branch,
      ordinal: ordinal++,
      id: deterministicUuid(`claude-session:${wt.path}`, 1),
      expectedMatch: 'strong',
    })
  }
  if (includeOrphan) {
    specs.push({
      kind: 'orphan-worktree',
      cwd: orphanWorktreePath,
      gitBranch: `worktree-${FIXTURE_ORPHAN_WORKTREE_NAME}`,
      ordinal: ordinal++,
      id: deterministicUuid(`claude-session:${orphanWorktreePath}`, 1),
      expectedMatch: 'strong',
    })
  }
  specs.push({
    kind: 'other-project',
    cwd: otherProjectPath,
    gitBranch: 'main',
    ordinal,
    id: deterministicUuid(`claude-session:${otherProjectPath}`, 1),
    expectedMatch: 'none',
  })
  const sessions: ClaudeSessionFixture[] = []
  for (const spec of specs) sessions.push(await writeSession(claudeConfigDir, spec))
  const projectSessions = sessions.filter((s) => s.kind === 'project')
  const firstSessionId = projectSessions[0]?.id ?? ''

  // ---- auto memory (repo-root project dir only, never under worktree dirs) ----
  const projectDir = path.join(claudeConfigDir, 'projects', encodeClaudeProjectDir(projectPath))
  const memoryDir = path.join(projectDir, 'memory')
  const memoryIndex = path.join(memoryDir, 'MEMORY.md')
  const memoryNotes = path.join(memoryDir, 'notes.md')
  await writeText(memoryIndex, '# Memory index\n\n- [notes](notes.md) — project conventions\n')
  await writeText(
    memoryNotes,
    `---\ntype: project\nmodified: ${isoAt(0, 0)}\n---\n\nThe project lives at ${projectPath}. Run pnpm test before committing.\n`,
  )

  // ---- history.jsonl: 3 rows for the project, 2 for the unrelated one, oldest first ----
  const otherSession = sessions.find((s) => s.kind === 'other-project')
  const historyRows: ClaudeHistoryRow[] = []
  for (let i = 0; i < 3; i += 1) {
    const session = projectSessions[i % projectSessions.length]
    if (!session) break
    historyRows.push({
      display: i === 0 ? FIXTURE_USER_PROMPT : `Follow-up prompt ${i} for the demo project`,
      pastedContents: {},
      timestamp: msAt(i, 1),
      project: projectPath,
      sessionId: session.id,
    })
  }
  if (otherSession) {
    for (let i = 0; i < 2; i += 1) {
      historyRows.push({
        display: `Prompt ${i + 1} in the unrelated project`,
        pastedContents: {},
        timestamp: msAt(i, 30),
        project: otherProjectPath,
        sessionId: otherSession.id,
      })
    }
  }
  historyRows.sort((a, b) => a.timestamp - b.timestamp)
  const historyJsonl = path.join(claudeConfigDir, 'history.jsonl')
  await writeJsonlLines(
    historyJsonl,
    historyRows.map((r) => JSON.stringify(r)),
  )

  // ---- user-scope files ----
  const files: ClaudeFixtureFiles = {
    settingsJson: path.join(claudeConfigDir, 'settings.json'),
    settingsLocalJson: path.join(claudeConfigDir, 'settings.local.json'),
    claudeMd: path.join(claudeConfigDir, 'CLAUDE.md'),
    statuslineScript: path.join(claudeConfigDir, 'statusline-command.sh'),
    skillMd: path.join(claudeConfigDir, 'skills', 'demo-skill', 'SKILL.md'),
    agentMd: path.join(claudeConfigDir, 'agents', 'reviewer.md'),
    installedPluginsJson: path.join(claudeConfigDir, 'plugins', 'installed_plugins.json'),
    knownMarketplacesJson: path.join(claudeConfigDir, 'plugins', 'known_marketplaces.json'),
    historyJsonl,
    memoryDir,
    memoryIndex,
    memoryNotes,
    sessionsRegistry: path.join(claudeConfigDir, 'sessions', `${FIXTURE_LIVE_SESSION_PID}.json`),
    sessionsKey: path.join(claudeConfigDir, 'sessions', `${FIXTURE_LIVE_SESSION_PID}.abc.key`),
    shellSnapshot: path.join(claudeConfigDir, 'shell-snapshots', 'snapshot-zsh-1.sh'),
  }
  await writeJson(files.settingsJson, {
    model: 'opus',
    cleanupPeriodDays: 90,
    statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh' },
  })
  await writeJson(files.settingsLocalJson, {})
  await writeText(files.claudeMd, '# User instructions\n\nPrefer pnpm. Keep answers short.\n')
  await writeText(files.statuslineScript, '#!/bin/bash\necho "fixture status line"\n')
  await writeText(
    files.skillMd,
    '---\nname: demo-skill\ndescription: Demo skill used by fixtures.\n---\n\nSay hello.\n',
  )
  await writeText(
    files.agentMd,
    '---\nname: reviewer\ndescription: Reviews code changes.\n---\n\nYou are a careful reviewer.\n',
  )
  await writeJson(files.installedPluginsJson, { version: 2, plugins: {} })
  await writeJson(files.knownMarketplacesJson, {})
  await writeJson(files.sessionsRegistry, {
    pid: FIXTURE_LIVE_SESSION_PID,
    sessionId: firstSessionId,
    cwd: projectPath,
    status: 'running',
    startedAt: isoAt(0, 0),
    messagingSocketPath: path.join(claudeConfigDir, 'sessions', `${FIXTURE_LIVE_SESSION_PID}.sock`),
  })
  await writeText(files.sessionsKey, `${FIXTURE_SESSION_KEY_TOKEN}\n`)
  await writeText(files.shellSnapshot, '# Snapshot file\nexport PATH=/usr/bin:/bin\n')

  // ---- ~/.claude.json ----
  const projectEntries: Record<string, unknown> = {
    [projectPath]: {
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
      lastSessionId: firstSessionId,
    },
    [orphanWorktreePath]: { allowedTools: [], hasTrustDialogAccepted: true },
    [otherProjectPath]: { allowedTools: [], hasTrustDialogAccepted: true },
  }
  for (const wt of worktrees) {
    projectEntries[wt.path] = { allowedTools: [], hasTrustDialogAccepted: true }
  }
  await writeJson(claudeJsonPath, {
    numStartups: 5,
    userID: 'u-fake',
    machineID: 'm-fake',
    oauthAccount: { accountUuid: 'fake', emailAddress: 'alice@example.com' },
    githubRepoPaths: { 'example/demo': [projectPath] },
    projects: projectEntries,
  })

  // ---- project-side files ----
  let projectFiles: ClaudeProjectFiles | undefined
  if (createProjectFiles) {
    const claudeDir = path.join(projectPath, '.claude')
    projectFiles = {
      claudeDir,
      settingsLocalJson: path.join(claudeDir, 'settings.local.json'),
      claudeLocalMd: path.join(projectPath, 'CLAUDE.local.md'),
      claudeMd: path.join(projectPath, 'CLAUDE.md'),
      mcpJson: path.join(projectPath, '.mcp.json'),
      nvmrc: path.join(projectPath, '.nvmrc'),
    }
    await writeJson(projectFiles.settingsLocalJson, { permissions: { allow: ['Bash(pnpm test)'] } })
    await writeText(
      projectFiles.claudeLocalMd,
      '# Local notes\n\nPersonal project notes; gitignored by convention.\n',
    )
    await writeText(projectFiles.claudeMd, '# demo\n\nProject instructions for Claude Code.\n')
    await writeJson(projectFiles.mcpJson, {
      mcpServers: { shared: { type: 'http', url: 'https://example.com/mcp' } },
    })
    await writeText(projectFiles.nvmrc, '22\n')
  }

  const encodedWorktrees: Record<string, string> = {}
  for (const wt of worktrees) encodedWorktrees[wt.path] = encodeClaudeProjectDir(wt.path)

  const fixture: ClaudeFixture = {
    claudeConfigDir,
    claudeJsonPath,
    projectPath,
    otherProjectPath,
    orphanWorktreePath,
    version: FIXTURE_CLAUDE_VERSION,
    projectsDir: path.join(claudeConfigDir, 'projects'),
    encoded: {
      project: encodeClaudeProjectDir(projectPath),
      orphanWorktree: encodeClaudeProjectDir(orphanWorktreePath),
      otherProject: encodeClaudeProjectDir(otherProjectPath),
      worktrees: encodedWorktrees,
    },
    projectDir,
    orphanWorktreeProjectDir: path.join(
      claudeConfigDir,
      'projects',
      encodeClaudeProjectDir(orphanWorktreePath),
    ),
    otherProjectDir: path.join(
      claudeConfigDir,
      'projects',
      encodeClaudeProjectDir(otherProjectPath),
    ),
    sessions,
    projectSessionIds: projectSessions.map((s) => s.id),
    expectedProjectSessionIds: sessions.filter((s) => s.expectedMatch !== 'none').map((s) => s.id),
    otherSessionIds: sessions.filter((s) => s.expectedMatch === 'none').map((s) => s.id),
    historyRows,
    files,
    secrets: [FIXTURE_MCP_SECRET, FIXTURE_SESSION_KEY_TOKEN],
    ephemeralPaths: [
      files.sessionsRegistry,
      files.sessionsKey,
      files.shellSnapshot,
      ...sessions.map((s) => s.sessionEnvDir),
    ],
  }
  if (projectFiles) fixture.projectFiles = projectFiles
  return fixture
}
