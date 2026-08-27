/**
 * Deterministic fixture data for the mock API. Nothing here is real: paths, names and
 * counts are invented to exercise every UI state (worktrees, a sensitive .env.local, a weak
 * Claude match, collisions on restore, an attention item for Claude auth).
 */
import type {
  AttentionItem,
  BackupHeaderInfo,
  Collision,
  Diagnostics,
  MachineInfo,
  Manifest,
  ManifestArtifact,
  ManifestProject,
  ManifestProviderSection,
  PathMapping,
  PathRemapReport,
  PreflightCheck,
  ProjectDescriptor,
  ProjectScanResult,
  ProviderRestoreOutcome,
  ProviderScanResult,
  RestorePlan,
  RestoreProjectPlan,
  RestoreResult,
  RestoreStep,
  ScanSession,
  ScannedArtifact,
  VerificationCheck,
} from '@devmig/model'
import { DEVBACKUP_FORMAT_VERSION } from '@devmig/model'
import { basename } from '../lib/paths'

export const MOCK_HOME = '/Users/cem'
export const MOCK_PROJECTS_DIR = `${MOCK_HOME}/Documents/GitHub`
export const MOCK_CLAUDE_DIR = `${MOCK_HOME}/.claude`
export const MOCK_BACKUP_DIR = `${MOCK_HOME}/Desktop`
export const MOCK_LOGS_DIR = `${MOCK_HOME}/Library/Logs/Dev Migration Assistant`
export const MOCK_APP_VERSION = '0.1.0'
export const MOCK_CLAUDE_VERSION = '2.1.247'

/** Paths the mock reports as existing on "this" Mac (drives collisions on restore). */
export const MOCK_EXISTING_PATHS: Record<string, { isDirectory: boolean; isEmpty: boolean }> = {
  [MOCK_HOME]: { isDirectory: true, isEmpty: false },
  [`${MOCK_HOME}/Documents`]: { isDirectory: true, isEmpty: false },
  [MOCK_PROJECTS_DIR]: { isDirectory: true, isEmpty: false },
  [`${MOCK_PROJECTS_DIR}/playagain`]: { isDirectory: true, isEmpty: false },
  [`${MOCK_HOME}/Projects/empty`]: { isDirectory: true, isEmpty: true },
  [MOCK_CLAUDE_DIR]: { isDirectory: true, isEmpty: false },
}

export function encodeClaudeDir(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, '-')
}

interface MockProjectSpec {
  id: string
  name: string
  branch: string
  head: string
  remote: string
  sessions: number
  sessionBytes: number
  checkpointBytes: number
  memoryNotes: number
  staged: number
  unstaged: number
  untracked: number
  bundleBytes: number
  worktrees: { path: string; branch: string; head: string; relativeToPrimary?: string }[]
  envFile: string | null
  weakMatch: { dir: string; sessions: number } | null
  nodeVersion: string
  packageManager: string
}

export const MOCK_PROJECT_SPECS: MockProjectSpec[] = [
  {
    id: 'proj_looplift',
    name: 'looplift',
    branch: 'main',
    head: 'a1b2c3d',
    remote: 'git@github.com:cem/looplift.git',
    sessions: 187,
    sessionBytes: 142_300_000,
    checkpointBytes: 23_400_000,
    memoryNotes: 12,
    staged: 3,
    unstaged: 4,
    untracked: 2,
    bundleBytes: 48_200_000,
    worktrees: [
      {
        path: `${MOCK_PROJECTS_DIR}/looplift/.claude/worktrees/pcd-blockers`,
        branch: 'feat/pcd-blockers',
        head: 'e4f5a6b',
        relativeToPrimary: '.claude/worktrees/pcd-blockers',
      },
      {
        path: `${MOCK_PROJECTS_DIR}/looplift-onboarding`,
        branch: 'onboarding',
        head: 'c7d8e9f',
        relativeToPrimary: '../looplift-onboarding',
      },
    ],
    envFile: '.env.local',
    weakMatch: null,
    nodeVersion: '22.12.0',
    packageManager: 'pnpm@11.5.3',
  },
  {
    id: 'proj_playagain',
    name: 'playagain',
    branch: 'develop',
    head: '9f8e7d6',
    remote: 'git@github.com:cem/playagain.git',
    sessions: 94,
    sessionBytes: 61_800_000,
    checkpointBytes: 9_100_000,
    memoryNotes: 5,
    staged: 0,
    unstaged: 1,
    untracked: 0,
    bundleBytes: 19_600_000,
    worktrees: [
      {
        path: `${MOCK_PROJECTS_DIR}/playagain-hotfix`,
        branch: 'hotfix/leaderboard',
        head: '1a2b3c4',
        relativeToPrimary: '../playagain-hotfix',
      },
    ],
    envFile: '.env.development.local',
    weakMatch: { dir: `-Users-cem-Documents-GitHub-playagain-old`, sessions: 12 },
    nodeVersion: '20.18.0',
    packageManager: 'pnpm@11.5.3',
  },
]

export function mockProjectPath(spec: MockProjectSpec): string {
  return `${MOCK_PROJECTS_DIR}/${spec.name}`
}

export const MOCK_PROJECT_PATHS = MOCK_PROJECT_SPECS.map(mockProjectPath)

export function findSpecByPath(p: string): MockProjectSpec | undefined {
  const normalized = p.replace(/\/+$/, '')
  return MOCK_PROJECT_SPECS.find((s) => mockProjectPath(s) === normalized)
}

export function findSpecByProjectId(id: string): MockProjectSpec | undefined {
  return MOCK_PROJECT_SPECS.find((s) => s.id === id)
}

export function mockMachine(capturedAt: string): MachineInfo {
  return {
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '26.6',
    machineLabel: 'MacBook Pro',
    homeDir: MOCK_HOME,
    userName: 'cem',
    tools: [
      { id: 'git', label: 'Git', version: '2.47.0', path: '/usr/bin/git', installed: true },
      {
        id: 'claude',
        label: 'Claude Code',
        version: MOCK_CLAUDE_VERSION,
        path: `${MOCK_HOME}/.local/bin/claude`,
        installed: true,
      },
      { id: 'node', label: 'Node.js', version: '22.12.0', path: null, installed: true },
      { id: 'pnpm', label: 'pnpm', version: '11.5.3', path: null, installed: true },
      { id: 'gh', label: 'GitHub CLI', version: null, path: null, installed: false },
    ],
    capturedAt,
  }
}

function describeProject(spec: MockProjectSpec): ProjectDescriptor {
  const root = mockProjectPath(spec)
  return {
    id: spec.id,
    name: spec.name,
    originalPath: root,
    canonicalPath: root,
    realPath: root,
    git: {
      root,
      commonDir: `${root}/.git`,
      remotes: [{ name: 'origin', fetchUrl: spec.remote }],
      head: spec.head,
      branch: spec.branch,
      detached: false,
      isLinkedWorktree: false,
      worktrees: [
        {
          path: root,
          branch: spec.branch,
          head: spec.head,
          isPrimary: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        ...spec.worktrees.map((w) => ({
          path: w.path,
          branch: w.branch,
          head: w.head,
          isPrimary: false,
          detached: false,
          locked: false,
          prunable: false,
          relativeToPrimary: w.relativeToPrimary,
        })),
      ],
    },
    detectedProviders: ['git', 'claude-code', 'project-files', 'runtime'],
  }
}

function describeUnknownProject(p: string, index: number): ProjectDescriptor {
  const root = p.replace(/\/+$/, '')
  return {
    id: `proj_${index}_${encodeClaudeDir(basename(root)).toLowerCase()}`,
    name: basename(root) || root,
    originalPath: p,
    canonicalPath: root,
    realPath: root,
    detectedProviders: ['project-files', 'runtime'],
  }
}

function artifact(
  partial: Omit<ScannedArtifact, 'selectable' | 'reasons' | 'meta'> &
    Partial<Pick<ScannedArtifact, 'selectable' | 'reasons' | 'meta'>>,
): ScannedArtifact {
  return { selectable: true, reasons: [], meta: {}, ...partial }
}

function gitScan(spec: MockProjectSpec): ProviderScanResult {
  const pid = spec.id
  const changed = spec.staged + spec.unstaged
  const artifacts: ScannedArtifact[] = [
    artifact({
      id: `git:${pid}:bundle`,
      providerId: 'git',
      projectId: pid,
      scope: 'project',
      kind: 'derived',
      label: 'Repository bundle (all branches, tags and HEAD)',
      description: 'git bundle create --all — restores offline without a remote',
      sizeBytes: spec.bundleBytes,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'bundle' },
    }),
    artifact({
      id: `git:${pid}:worktree-state`,
      providerId: 'git',
      projectId: pid,
      scope: 'project',
      kind: 'derived',
      label: `Working tree changes (${changed + spec.untracked} files)`,
      description: `${spec.staged} staged · ${spec.unstaged} unstaged · ${spec.untracked} untracked`,
      sizeBytes: 120_000 + changed * 8_000,
      count: changed + spec.untracked,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'worktree-state' },
    }),
  ]
  if (spec.worktrees.length > 0) {
    artifacts.push(
      artifact({
        id: `git:${pid}:worktrees`,
        providerId: 'git',
        projectId: pid,
        scope: 'project',
        kind: 'derived',
        label: `Worktrees (${spec.worktrees.length})`,
        description: spec.worktrees
          .map((w) => `${w.branch} → ${w.relativeToPrimary ?? w.path}`)
          .join(' · '),
        sizeBytes: spec.worktrees.length * 96_000,
        count: spec.worktrees.length,
        sensitivity: 'safe',
        includedByDefault: true,
        meta: { category: 'worktrees' },
      }),
    )
  }
  return {
    providerId: 'git',
    projectId: pid,
    detected: true,
    artifacts,
    summary: [
      { label: `${spec.branch} @ ${spec.head}`, status: 'ok', detail: 'origin in sync' },
      changed > 0
        ? {
            label: `${changed} modified file${changed === 1 ? '' : 's'}`,
            status: 'warn',
            detail: 'captured as staged/unstaged diffs',
          }
        : { label: 'Working tree clean', status: 'ok' },
      spec.worktrees.length > 0
        ? {
            label: `${spec.worktrees.length} linked worktree${spec.worktrees.length === 1 ? '' : 's'}`,
            status: 'ok',
          }
        : { label: 'No linked worktrees', status: 'info' },
    ],
    warnings: [],
    estimatedBytes: artifacts.reduce((n, a) => n + (a.sizeBytes ?? 0), 0),
  }
}

function claudeScan(spec: MockProjectSpec): ProviderScanResult {
  const pid = spec.id
  const root = mockProjectPath(spec)
  const encoded = encodeClaudeDir(root)
  const artifacts: ScannedArtifact[] = [
    artifact({
      id: `claude:${pid}:sessions`,
      providerId: 'claude-code',
      projectId: pid,
      scope: 'project',
      kind: 'file-set',
      label: `Claude Code sessions (${spec.sessions})`,
      description: 'Transcripts, subagent transcripts and spilled tool results',
      sourcePath: `~/.claude/projects/${encoded}`,
      sizeBytes: spec.sessionBytes,
      count: spec.sessions,
      sensitivity: 'safe',
      includedByDefault: true,
      reasons: ['Matched by transcript cwd (exact)', 'Includes worktree sessions'],
      meta: { category: 'sessions', confidence: 'exact', encodedDir: encoded },
    }),
    artifact({
      id: `claude:${pid}:file-history`,
      providerId: 'claude-code',
      projectId: pid,
      scope: 'project',
      kind: 'file-set',
      label: `Checkpoints (${spec.sessions} sessions)`,
      description: 'file-history/ blobs so /rewind keeps working',
      sourcePath: '~/.claude/file-history',
      sizeBytes: spec.checkpointBytes,
      count: spec.sessions,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'file-history' },
    }),
    artifact({
      id: `claude:${pid}:memory`,
      providerId: 'claude-code',
      projectId: pid,
      scope: 'project',
      kind: 'directory',
      label: `Auto memory (${spec.memoryNotes} notes)`,
      sourcePath: `~/.claude/projects/${encoded}/memory`,
      sizeBytes: spec.memoryNotes * 2_400,
      count: spec.memoryNotes,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'memory' },
    }),
    artifact({
      id: `claude:${pid}:settings-local`,
      providerId: 'claude-code',
      projectId: pid,
      scope: 'project',
      kind: 'file',
      label: '.claude/settings.local.json',
      description: 'Permission approvals and MCP server approvals',
      sourcePath: `${root}/.claude/settings.local.json`,
      sizeBytes: 1_180,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'settings' },
    }),
    artifact({
      id: `claude:${pid}:mcp`,
      providerId: 'claude-code',
      projectId: pid,
      scope: 'project',
      kind: 'file',
      label: '.mcp.json',
      description: 'Project MCP servers',
      sourcePath: `${root}/.mcp.json`,
      sizeBytes: 642,
      sensitivity: 'sensitive',
      includedByDefault: false,
      reasons: ['Contains an env block with a key named API_KEY'],
      meta: { category: 'mcp' },
    }),
  ]
  if (spec.weakMatch) {
    artifacts.push(
      artifact({
        id: `claude:${pid}:sessions-weak`,
        providerId: 'claude-code',
        projectId: pid,
        scope: 'project',
        kind: 'file-set',
        label: `Possible sessions in ${spec.weakMatch.dir} (${spec.weakMatch.sessions})`,
        description: 'Directory name resembles this project but no transcript records its path',
        sourcePath: `~/.claude/projects/${spec.weakMatch.dir}`,
        sizeBytes: spec.weakMatch.sessions * 310_000,
        count: spec.weakMatch.sessions,
        sensitivity: 'safe',
        includedByDefault: false,
        reasons: [
          'Name-only match: no cwd evidence in transcripts',
          'Review before including — may belong to a moved or deleted project',
        ],
        meta: { category: 'sessions', confidence: 'weak', encodedDir: spec.weakMatch.dir },
      }),
    )
  }
  return {
    providerId: 'claude-code',
    projectId: pid,
    detected: true,
    artifacts,
    summary: [
      { label: `${spec.sessions} sessions`, status: 'ok', detail: `~/.claude/projects/${encoded}` },
      {
        label: 'Project directory encoding verified',
        status: 'ok',
        detail: 'cwd evidence agrees with directory name',
      },
      ...(spec.weakMatch
        ? [
            {
              label: `1 weak match needs review`,
              status: 'warn' as const,
              detail: spec.weakMatch.dir,
            },
          ]
        : []),
    ],
    warnings: [],
    estimatedBytes: artifacts
      .filter((a) => a.includedByDefault)
      .reduce((n, a) => n + (a.sizeBytes ?? 0), 0),
  }
}

function projectFilesScan(spec: MockProjectSpec): ProviderScanResult {
  const pid = spec.id
  const root = mockProjectPath(spec)
  const artifacts: ScannedArtifact[] = []
  if (spec.envFile) {
    artifacts.push(
      artifact({
        id: `files:${pid}:env`,
        providerId: 'project-files',
        projectId: pid,
        scope: 'project',
        kind: 'file',
        label: spec.envFile,
        description: 'Local environment file (git-ignored)',
        sourcePath: `${root}/${spec.envFile}`,
        sizeBytes: 1_240,
        count: 1,
        sensitivity: 'sensitive',
        includedByDefault: false,
        reasons: ['Matches the .env* pattern', '6 values look like API keys or tokens'],
        meta: { category: 'env' },
      }),
    )
  }
  artifacts.push(
    artifact({
      id: `files:${pid}:vscode`,
      providerId: 'project-files',
      projectId: pid,
      scope: 'project',
      kind: 'directory',
      label: '.vscode/ (editor settings)',
      sourcePath: `${root}/.vscode`,
      sizeBytes: 3_900,
      count: 2,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'editor' },
    }),
    artifact({
      id: `files:${pid}:claude-local-md`,
      providerId: 'project-files',
      projectId: pid,
      scope: 'project',
      kind: 'file',
      label: 'CLAUDE.local.md',
      sourcePath: `${root}/CLAUDE.local.md`,
      sizeBytes: 2_210,
      count: 1,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'memory' },
    }),
    artifact({
      id: `files:${pid}:node-modules`,
      providerId: 'project-files',
      projectId: pid,
      scope: 'ephemeral',
      kind: 'directory',
      label: 'node_modules/',
      sourcePath: `${root}/node_modules`,
      sizeBytes: 1_240_000_000,
      sensitivity: 'safe',
      includedByDefault: false,
      selectable: false,
      reasons: ['Reinstall with pnpm install on the destination'],
      meta: { category: 'dependencies' },
    }),
  )
  return {
    providerId: 'project-files',
    projectId: pid,
    detected: true,
    artifacts,
    summary: [
      spec.envFile
        ? {
            label: `${spec.envFile} detected`,
            status: 'warn',
            detail: 'sensitive — excluded unless you opt in',
          }
        : { label: 'No local env files', status: 'info' },
      { label: '2 untracked config files', status: 'ok' },
    ],
    warnings: [],
    estimatedBytes: artifacts
      .filter((a) => a.includedByDefault)
      .reduce((n, a) => n + (a.sizeBytes ?? 0), 0),
  }
}

function runtimeScan(spec: MockProjectSpec): ProviderScanResult {
  const pid = spec.id
  return {
    providerId: 'runtime',
    projectId: pid,
    detected: true,
    artifacts: [
      artifact({
        id: `runtime:${pid}:versions`,
        providerId: 'runtime',
        projectId: pid,
        scope: 'project',
        kind: 'json-fragment',
        label: 'Tool versions (.nvmrc, packageManager)',
        description: `Node ${spec.nodeVersion} · ${spec.packageManager}`,
        sizeBytes: 220,
        sensitivity: 'safe',
        includedByDefault: true,
        meta: { category: 'versions' },
      }),
    ],
    summary: [
      { label: `Node ${spec.nodeVersion} (.nvmrc)`, status: 'ok' },
      { label: spec.packageManager, status: 'ok', detail: 'package.json packageManager' },
    ],
    warnings: [],
    estimatedBytes: 220,
  }
}

function unknownProjectScan(project: ProjectDescriptor): ProjectScanResult {
  const pid = project.id
  const files: ProviderScanResult = {
    providerId: 'project-files',
    projectId: pid,
    detected: true,
    artifacts: [
      artifact({
        id: `files:${pid}:all`,
        providerId: 'project-files',
        projectId: pid,
        scope: 'project',
        kind: 'directory',
        label: 'Untracked local files',
        sourcePath: project.canonicalPath,
        sizeBytes: 12_000,
        count: 4,
        sensitivity: 'safe',
        includedByDefault: true,
      }),
    ],
    summary: [{ label: 'Not a Git repository', status: 'info' }],
    warnings: [],
    estimatedBytes: 12_000,
  }
  return {
    project,
    providers: [
      {
        providerId: 'git',
        projectId: pid,
        detected: false,
        artifacts: [],
        summary: [{ label: 'No repository found', status: 'info' }],
        warnings: [],
        estimatedBytes: 0,
      },
      {
        providerId: 'claude-code',
        projectId: pid,
        detected: false,
        artifacts: [],
        summary: [{ label: 'No Claude Code sessions for this path', status: 'info' }],
        warnings: [],
        estimatedBytes: 0,
      },
      files,
      {
        providerId: 'runtime',
        projectId: pid,
        detected: false,
        artifacts: [],
        summary: [],
        warnings: [],
        estimatedBytes: 0,
      },
    ],
    estimatedBytes: 12_000,
    warnings: ['No Git repository or Claude Code data was found for this directory.'],
  }
}

export function buildMockGlobalScan(): ProviderScanResult[] {
  const claude: ScannedArtifact[] = [
    artifact({
      id: 'claude:global:settings',
      providerId: 'claude-code',
      scope: 'user',
      kind: 'file',
      label: '~/.claude/settings.json',
      description: 'Theme, model, permissions, hooks, plugins',
      sourcePath: '~/.claude/settings.json',
      sizeBytes: 2_860,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'settings' },
    }),
    artifact({
      id: 'claude:global:memory',
      providerId: 'claude-code',
      scope: 'user',
      kind: 'file-set',
      label: '~/.claude/CLAUDE.md and rules/ (4 files)',
      sourcePath: '~/.claude/CLAUDE.md',
      sizeBytes: 9_400,
      count: 4,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'memory' },
    }),
    artifact({
      id: 'claude:global:claude-json',
      providerId: 'claude-code',
      scope: 'user',
      kind: 'json-fragment',
      label: '~/.claude.json project entries (selected projects only)',
      description: 'Trust decisions, allowed tools and MCP approvals per project',
      sourcePath: '~/.claude.json',
      sizeBytes: 5_120,
      count: 2,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'registry' },
    }),
    artifact({
      id: 'claude:global:history',
      providerId: 'claude-code',
      scope: 'user',
      kind: 'derived',
      label: 'Prompt history for selected projects (1,204 entries)',
      sourcePath: '~/.claude/history.jsonl',
      sizeBytes: 388_000,
      count: 1_204,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'history' },
    }),
    artifact({
      id: 'claude:global:plugins',
      providerId: 'claude-code',
      scope: 'user',
      kind: 'file-set',
      label: 'Plugins and marketplaces (3 installed)',
      sourcePath: '~/.claude/plugins',
      sizeBytes: 1_900_000,
      count: 3,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'plugins' },
    }),
    artifact({
      id: 'claude:global:credentials',
      providerId: 'claude-code',
      scope: 'user',
      kind: 'derived',
      label: 'Claude Code sign-in (macOS Keychain)',
      description: 'OAuth tokens are never migrated',
      sizeBytes: 0,
      sensitivity: 'credential',
      includedByDefault: false,
      selectable: false,
      reasons: ['Stored in the macOS Keychain', 'Sign in again on the destination Mac'],
      meta: { category: 'credentials' },
    }),
    artifact({
      id: 'claude:global:session-env',
      providerId: 'claude-code',
      scope: 'ephemeral',
      kind: 'directory',
      label: 'session-env/ (209 hook environments)',
      sourcePath: '~/.claude/session-env',
      sizeBytes: 452_000,
      count: 209,
      sensitivity: 'sensitive',
      includedByDefault: false,
      selectable: false,
      reasons: ['Regenerated by hooks at every SessionStart', 'May contain exported secrets'],
      meta: { category: 'ephemeral' },
    }),
    artifact({
      id: 'claude:global:statsig',
      providerId: 'claude-code',
      scope: 'ephemeral',
      kind: 'directory',
      label: 'statsig/, debug/, paste-cache/',
      sizeBytes: 31_000_000,
      sensitivity: 'safe',
      includedByDefault: false,
      selectable: false,
      reasons: ['Machine-local caches; rebuilt automatically'],
      meta: { category: 'ephemeral' },
    }),
  ]
  const git: ScannedArtifact[] = [
    artifact({
      id: 'git:global:gitconfig',
      providerId: 'git',
      scope: 'user',
      kind: 'file',
      label: '~/.gitconfig',
      description: 'user.name, aliases, credential helper settings',
      sourcePath: '~/.gitconfig',
      sizeBytes: 1_030,
      sensitivity: 'sensitive',
      includedByDefault: false,
      reasons: ['Contains a credential.helper entry'],
      meta: { category: 'config' },
    }),
    artifact({
      id: 'git:global:ignore',
      providerId: 'git',
      scope: 'user',
      kind: 'file',
      label: '~/.config/git/ignore',
      description: 'Global excludes (keeps settings.local.json out of repos)',
      sourcePath: '~/.config/git/ignore',
      sizeBytes: 120,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'config' },
    }),
  ]
  const runtime: ScannedArtifact[] = [
    artifact({
      id: 'runtime:global:tools',
      providerId: 'runtime',
      scope: 'user',
      kind: 'json-fragment',
      label: 'Installed tool versions (informational)',
      description: 'git 2.47.0 · claude 2.1.247 · node 22.12.0 · pnpm 11.5.3',
      sizeBytes: 640,
      sensitivity: 'safe',
      includedByDefault: true,
      meta: { category: 'versions' },
    }),
  ]
  return [
    {
      providerId: 'claude-code',
      detected: true,
      artifacts: claude,
      summary: [
        { label: `Claude Code ${MOCK_CLAUDE_VERSION}`, status: 'ok', detail: '~/.claude' },
        {
          label: 'Sign-in stays in Keychain',
          status: 'info',
          detail: 're-authenticate on the destination',
        },
      ],
      warnings: [],
      estimatedBytes: claude
        .filter((a) => a.includedByDefault)
        .reduce((n, a) => n + (a.sizeBytes ?? 0), 0),
    },
    {
      providerId: 'git',
      detected: true,
      artifacts: git,
      summary: [{ label: 'Git 2.47.0', status: 'ok' }],
      warnings: [],
      estimatedBytes: 120,
    },
    {
      providerId: 'runtime',
      detected: true,
      artifacts: runtime,
      summary: [{ label: 'Node 22.12.0 · pnpm 11.5.3', status: 'ok' }],
      warnings: [],
      estimatedBytes: 640,
    },
  ]
}

/** Builds a complete ScanSession for the given directories (unknown paths get a minimal result). */
export function buildMockScanSession(
  paths: string[],
  includeGlobal: boolean,
  scanId: string,
  createdAt: string,
): ScanSession {
  const projects: ProjectScanResult[] = paths.map((p, index) => {
    const spec = findSpecByPath(p)
    if (!spec) return unknownProjectScan(describeUnknownProject(p, index))
    const project = describeProject(spec)
    const providers = [gitScan(spec), claudeScan(spec), projectFilesScan(spec), runtimeScan(spec)]
    return {
      project,
      providers,
      estimatedBytes: providers.reduce((n, r) => n + r.estimatedBytes, 0),
      warnings: [],
    }
  })
  return {
    id: scanId,
    createdAt,
    projects,
    global: includeGlobal ? buildMockGlobalScan() : [],
    warnings: [],
  }
}

export function defaultSelection(scan: ScanSession): string[] {
  const ids: string[] = []
  for (const p of scan.projects)
    for (const r of p.providers)
      for (const a of r.artifacts) if (a.selectable && a.includedByDefault) ids.push(a.id)
  for (const r of scan.global)
    for (const a of r.artifacts) if (a.selectable && a.includedByDefault) ids.push(a.id)
  return ids
}

function toManifestArtifact(a: ScannedArtifact, payloadPrefix: string): ManifestArtifact {
  return {
    id: a.id,
    providerId: a.providerId,
    kind: a.kind,
    label: a.label,
    payloadPath: `${payloadPrefix}/${a.id.replace(/[^A-Za-z0-9._-]/g, '_')}`,
    sizeBytes: a.sizeBytes ?? 0,
    fileCount: a.count,
    sensitivity: a.sensitivity,
    sourcePath: a.sourcePath,
    meta: a.meta,
  }
}

/** Turns a scan + selection into the manifest a real backup would carry. */
export function buildMockManifest(
  scan: ScanSession,
  selectedIds: ReadonlySet<string>,
  label: string,
  createdAt: string,
  manifestId: string,
): Manifest {
  const projects: ManifestProject[] = scan.projects.map((p) => {
    const providers: ManifestProviderSection[] = p.providers
      .map((r) => ({
        providerId: r.providerId,
        schemaVersion: 1,
        artifacts: r.artifacts
          .filter((a) => selectedIds.has(a.id))
          .map((a) => toManifestArtifact(a, `projects/${p.project.id}/${r.providerId}`)),
        summary: Object.fromEntries(r.summary.map((s) => [s.label, s.detail ?? s.status])),
      }))
      .filter((s) => s.artifacts.length > 0)
    return {
      id: p.project.id,
      name: p.project.name,
      originalPath: p.project.originalPath,
      canonicalPath: p.project.canonicalPath,
      git: p.project.git,
      providers,
    }
  })
  const global: ManifestProviderSection[] = scan.global
    .map((r) => ({
      providerId: r.providerId,
      schemaVersion: 1,
      artifacts: r.artifacts
        .filter((a) => selectedIds.has(a.id))
        .map((a) => toManifestArtifact(a, `global/${r.providerId}`)),
      summary: {},
    }))
    .filter((s) => s.artifacts.length > 0)

  let artifactCount = 0
  let payloadBytes = 0
  let claudeSessionCount = 0
  let worktreeCount = 0
  for (const p of projects) {
    for (const s of p.providers)
      for (const a of s.artifacts) {
        artifactCount += 1
        payloadBytes += a.sizeBytes
        if (a.providerId === 'claude-code' && a.meta['category'] === 'sessions')
          claudeSessionCount += a.fileCount ?? 0
        if (a.providerId === 'git' && a.meta['category'] === 'worktrees')
          worktreeCount += a.fileCount ?? 0
      }
  }
  for (const s of global)
    for (const a of s.artifacts) {
      artifactCount += 1
      payloadBytes += a.sizeBytes
    }
  return {
    format: 'devbackup',
    formatVersion: DEVBACKUP_FORMAT_VERSION,
    id: manifestId,
    label,
    createdAt,
    appVersion: MOCK_APP_VERSION,
    machine: mockMachine(createdAt),
    providers: { git: 1, 'claude-code': 1, 'project-files': 1, runtime: 1 },
    projects,
    global,
    stats: {
      projectCount: projects.length,
      artifactCount,
      payloadBytes,
      claudeSessionCount,
      worktreeCount,
    },
    restoreHints: { claudeDirEncoding: 'non-alnum-to-dash', claudeDirEncodingVerified: true },
  }
}

export function mockHeaderInfo(
  path: string,
  sizeBytes: number,
  createdAt: string,
): BackupHeaderInfo {
  const unsupported = /unsupported|v99/i.test(path)
  return {
    path,
    sizeBytes,
    formatVersion: unsupported ? 99 : DEVBACKUP_FORMAT_VERSION,
    supported: !unsupported,
    kdf: { algorithm: 'argon2id', memoryKiB: 262_144, iterations: 3, parallelism: 4 },
    cipher: 'aes-256-gcm',
    createdAt,
  }
}

export function sessionCountFor(manifest: Manifest, projectId: string): number {
  const project = manifest.projects.find((p) => p.id === projectId)
  if (!project) return 0
  let n = 0
  for (const s of project.providers)
    for (const a of s.artifacts)
      if (
        a.providerId === 'claude-code' &&
        a.meta['category'] === 'sessions' &&
        a.meta['confidence'] !== 'weak'
      )
        n += a.fileCount ?? 0
  return n
}

export function buildMockRemapReport(manifest: Manifest, mappings: PathMapping[]): PathRemapReport {
  const changed = mappings.filter((m) => m.oldPath !== m.newPath)
  const affected: PathRemapReport['affected'] = []
  const warnings: string[] = []
  const unsupportedReferences: PathRemapReport['unsupportedReferences'] = []
  let safeRewriteCount = 0
  for (const m of changed) {
    const project = manifest.projects.find((p) => p.id === m.projectId)
    const name = project?.name ?? m.projectId
    const sessions = sessionCountFor(manifest, m.projectId)
    const worktrees = project?.git?.worktrees.filter((w) => !w.isPrimary).length ?? 0
    if (sessions > 0) {
      affected.push({
        providerId: 'claude-code',
        label: `Claude Code sessions (${name})`,
        count: sessions,
      })
      affected.push({
        providerId: 'claude-code',
        label: `history.jsonl entries (${name})`,
        count: Math.round(sessions * 4.2),
      })
      affected.push({
        providerId: 'claude-code',
        label: `~/.claude.json entry (${name})`,
        count: 1,
      })
      safeRewriteCount += sessions + Math.round(sessions * 4.2) + 1
    }
    if (worktrees > 0) {
      affected.push({
        providerId: 'git',
        label: `Worktree paths recomputed (${name})`,
        count: worktrees,
      })
      safeRewriteCount += worktrees
    }
    if (name === 'looplift') {
      warnings.push(
        'looplift/CLAUDE.md imports @/Users/cem/notes/looplift.md — absolute @imports are preserved, not rewritten.',
      )
      unsupportedReferences.push({
        providerId: 'claude-code',
        location: 'looplift/CLAUDE.md',
        reason: 'Absolute @import path inside prose; edit by hand after restore.',
      })
    }
  }
  return { mappings: changed, affected, safeRewriteCount, warnings, unsupportedReferences }
}

export function buildMockRestorePlan(
  planId: string,
  backupPath: string,
  manifest: Manifest,
  mappings: PathMapping[],
  selected: ReadonlySet<string>,
  includeGlobal: boolean,
  createdAt: string,
  pathExists: (p: string) => { exists: boolean; isEmpty: boolean },
): RestorePlan {
  const preflight: PreflightCheck[] = [
    {
      id: 'git-installed',
      label: 'Git available',
      status: 'pass',
      detail: 'git 2.47.0 at /usr/bin/git',
      blocking: true,
      providerId: 'git',
    },
    {
      id: 'claude-installed',
      label: 'Claude Code installed',
      status: 'pass',
      detail: `claude ${MOCK_CLAUDE_VERSION}`,
      blocking: false,
      providerId: 'claude-code',
    },
    {
      id: 'claude-not-running',
      label: 'Claude Code not running',
      status: 'warn',
      detail: 'A claude process is running; sessions it writes during restore are not merged.',
      blocking: false,
      providerId: 'claude-code',
    },
    {
      id: 'claude-encoding',
      label: 'Claude project directory encoding verified',
      status: 'pass',
      detail: 'Existing ~/.claude/projects entries agree with the recorded encoding',
      blocking: false,
      providerId: 'claude-code',
    },
    {
      id: 'disk-space',
      label: 'Disk space',
      status: 'pass',
      detail: '212 GB free',
      blocking: true,
    },
  ]
  const projects: RestoreProjectPlan[] = []
  for (const mp of manifest.projects) {
    const mapping = mappings.find((m) => m.projectId === mp.id)
    const newPath = mapping?.newPath ?? mp.canonicalPath
    const pathChanged = newPath !== mp.canonicalPath
    const steps: RestoreStep[] = []
    const collisions: Collision[] = []
    const warnings: string[] = []
    const selectedArtifacts = mp.providers.flatMap((s) =>
      s.artifacts.filter((a) => selected.has(a.id)),
    )
    const ids = (providerId: string): string[] =>
      selectedArtifacts.filter((a) => a.providerId === providerId).map((a) => a.id)
    const worktrees = mp.git?.worktrees.filter((w) => !w.isPrimary) ?? []
    const sessions = sessionCountFor(manifest, mp.id)

    const unwritable = /\/Volumes\/|readonly/i.test(newPath)
    preflight.push({
      id: `dest-writable:${mp.id}`,
      label: `Destination writable — ${mp.name}`,
      status: unwritable ? 'fail' : 'pass',
      detail: unwritable ? `${newPath} is not writable by the current user` : newPath,
      blocking: true,
      projectId: mp.id,
    })

    const destination = pathExists(newPath)
    if (ids('git').length > 0) {
      steps.push({
        id: `git:${mp.id}:clone`,
        providerId: 'git',
        projectId: mp.id,
        label: 'Clone repository from bundle',
        detail: `${mp.git?.branch ?? 'HEAD'} @ ${mp.git?.head ?? '?'}`,
        destination: newPath,
        artifactIds: ids('git'),
      })
      if (worktrees.length > 0)
        steps.push({
          id: `git:${mp.id}:worktrees`,
          providerId: 'git',
          projectId: mp.id,
          label: `Recreate ${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'}`,
          detail: worktrees.map((w) => w.branch ?? 'detached').join(', '),
          destination: newPath,
          artifactIds: ids('git'),
        })
      steps.push({
        id: `git:${mp.id}:apply`,
        providerId: 'git',
        projectId: mp.id,
        label: 'Apply staged, unstaged and untracked changes',
        destination: newPath,
        artifactIds: ids('git'),
      })
      if (destination.exists && !destination.isEmpty)
        collisions.push({
          id: `git:${mp.id}:repo-exists`,
          providerId: 'git',
          projectId: mp.id,
          kind: 'git-repo-exists',
          path: newPath,
          detail: 'A directory with a Git repository already exists at this path.',
          allowedPolicies: ['skip', 'backup-then-replace', 'alternate-path'],
          policy: 'skip',
        })
    }
    if (ids('claude-code').length > 0) {
      const encoded = encodeClaudeDir(newPath)
      steps.push({
        id: `claude:${mp.id}:sessions`,
        providerId: 'claude-code',
        projectId: mp.id,
        label: `Restore ${sessions} sessions${pathChanged ? ' with safe path remapping' : ''}`,
        destination: `~/.claude/projects/${encoded}`,
        artifactIds: ids('claude-code'),
      })
      steps.push({
        id: `claude:${mp.id}:registry`,
        providerId: 'claude-code',
        projectId: mp.id,
        label: 'Register project in ~/.claude.json',
        destination: '~/.claude.json',
        artifactIds: ids('claude-code'),
      })
      if (destination.exists && !destination.isEmpty)
        collisions.push({
          id: `claude:${mp.id}:project-exists`,
          providerId: 'claude-code',
          projectId: mp.id,
          kind: 'claude-project-exists',
          path: `~/.claude/projects/${encoded}`,
          detail:
            'Claude Code already has sessions for this path. Merge adds missing sessions by id and keeps differing copies as .devmig-conflict.jsonl.',
          allowedPolicies: ['skip', 'merge', 'backup-then-replace'],
          policy: 'skip',
        })
    }
    if (ids('project-files').length > 0)
      steps.push({
        id: `files:${mp.id}`,
        providerId: 'project-files',
        projectId: mp.id,
        label: `Restore ${ids('project-files').length} local file${ids('project-files').length === 1 ? '' : 's'}`,
        destination: newPath,
        artifactIds: ids('project-files'),
      })
    if (ids('runtime').length > 0)
      steps.push({
        id: `runtime:${mp.id}`,
        providerId: 'runtime',
        projectId: mp.id,
        label: 'Compare tool versions and report differences',
        artifactIds: ids('runtime'),
      })
    if (pathChanged)
      warnings.push(
        `Path changes from ${mp.canonicalPath} to ${newPath}; ${sessions} sessions will be remapped.`,
      )
    projects.push({
      projectId: mp.id,
      name: mp.name,
      oldPath: mp.canonicalPath,
      newPath,
      pathChanged,
      steps,
      collisions,
      warnings,
    })
  }

  const globalSteps: RestoreStep[] = []
  const globalCollisions: Collision[] = []
  if (includeGlobal) {
    for (const section of manifest.global) {
      const artifacts = section.artifacts.filter((a) => selected.has(a.id))
      for (const a of artifacts)
        globalSteps.push({
          id: `global:${a.id}`,
          providerId: section.providerId,
          label: `Restore ${a.label}`,
          destination: a.sourcePath,
          artifactIds: [a.id],
        })
      if (
        section.providerId === 'claude-code' &&
        artifacts.some((a) => a.meta['category'] === 'settings')
      )
        globalCollisions.push({
          id: 'claude:global:settings-exists',
          providerId: 'claude-code',
          kind: 'file-exists',
          path: '~/.claude/settings.json',
          detail: 'A settings.json already exists on this Mac.',
          allowedPolicies: ['skip', 'backup-then-replace'],
          policy: 'skip',
        })
      if (
        section.providerId === 'claude-code' &&
        artifacts.some((a) => a.meta['category'] === 'registry')
      )
        globalCollisions.push({
          id: 'claude:global:claude-json-entries',
          providerId: 'claude-code',
          kind: 'json-entry-exists',
          path: '~/.claude.json',
          detail:
            'Project entries already exist; merge keeps existing entries and adds missing ones.',
          allowedPolicies: ['skip', 'merge'],
          policy: 'skip',
        })
    }
  }
  const remap = buildMockRemapReport(manifest, mappings)
  const canProceed = !preflight.some((c) => c.status === 'fail' && c.blocking)
  return {
    id: planId,
    backupPath,
    createdAt,
    projects,
    globalSteps,
    globalCollisions,
    preflight,
    remap,
    warnings: remap.warnings,
    canProceed,
  }
}

export function buildMockRestoreResult(
  plan: RestorePlan,
  manifest: Manifest,
  decisions: Record<string, string>,
  durationMs: number,
): RestoreResult {
  const checks: VerificationCheck[] = []
  const projects = plan.projects.map((p) => {
    const mp = manifest.projects.find((m) => m.id === p.projectId)
    const worktrees = mp?.git?.worktrees.filter((w) => !w.isPrimary).length ?? 0
    const sessions = sessionCountFor(manifest, p.projectId)
    const providers: ProviderRestoreOutcome[] = []
    const repoCollision = p.collisions.find((c) => c.kind === 'git-repo-exists')
    const repoPolicy = repoCollision ? (decisions[repoCollision.id] ?? repoCollision.policy) : null
    if (p.steps.some((s) => s.providerId === 'git')) {
      if (repoPolicy === 'skip') {
        providers.push({
          providerId: 'git',
          projectId: p.projectId,
          status: 'skipped',
          items: [
            { label: 'Existing repository left untouched', status: 'info', detail: p.newPath },
          ],
          warnings: [],
        })
      } else {
        providers.push({
          providerId: 'git',
          projectId: p.projectId,
          status: 'ok',
          items: [
            { label: 'Cloned from bundle', status: 'ok', detail: p.newPath },
            {
              label: `Checked out ${mp?.git?.branch ?? 'HEAD'} @ ${mp?.git?.head ?? '?'}`,
              status: 'ok',
            },
            ...(worktrees > 0
              ? [
                  {
                    label: `${worktrees} worktree${worktrees === 1 ? '' : 's'} recreated`,
                    status: 'ok' as const,
                  },
                ]
              : []),
            { label: 'Staged and unstaged changes applied', status: 'ok' },
            ...(repoPolicy === 'backup-then-replace'
              ? [
                  {
                    label: 'Previous checkout moved aside',
                    status: 'warn' as const,
                    detail: `${p.newPath}.devmig-backup-…`,
                  },
                ]
              : []),
          ],
          warnings: [],
        })
        checks.push({
          id: `git-status:${p.projectId}`,
          label: `${p.name}: git status matches captured state`,
          status: 'pass',
          providerId: 'git',
          projectId: p.projectId,
        })
        if (worktrees > 0)
          checks.push({
            id: `worktrees:${p.projectId}`,
            label: `${p.name}: worktree list matches`,
            status: 'pass',
            providerId: 'git',
            projectId: p.projectId,
          })
      }
    }
    const claudeCollision = p.collisions.find((c) => c.kind === 'claude-project-exists')
    const claudePolicy = claudeCollision
      ? (decisions[claudeCollision.id] ?? claudeCollision.policy)
      : null
    if (p.steps.some((s) => s.providerId === 'claude-code')) {
      if (claudePolicy === 'skip') {
        providers.push({
          providerId: 'claude-code',
          projectId: p.projectId,
          status: 'skipped',
          items: [
            {
              label: 'Existing Claude Code sessions kept; backup sessions not restored',
              status: 'info',
            },
          ],
          warnings: [],
        })
      } else {
        const merged = claudePolicy === 'merge'
        providers.push({
          providerId: 'claude-code',
          projectId: p.projectId,
          status: merged ? 'partial' : 'ok',
          items: [
            {
              label: `${sessions} sessions restored`,
              status: 'ok',
              detail: p.pathChanged
                ? 'paths remapped in cwd and checkpoint metadata'
                : 'no remapping needed',
            },
            { label: 'Checkpoints and auto memory restored', status: 'ok' },
            { label: 'Project registered in ~/.claude.json', status: 'ok' },
            ...(merged
              ? [
                  {
                    label: '1 session differed from the local copy',
                    status: 'warn' as const,
                    detail: 'kept as 3f9c…-devmig-conflict.jsonl',
                  },
                ]
              : []),
          ],
          warnings: [],
        })
        checks.push({
          id: `claude-sessions:${p.projectId}`,
          label: `${p.name}: ${sessions} transcripts verified`,
          status: 'pass',
          providerId: 'claude-code',
          projectId: p.projectId,
        })
      }
    }
    if (p.steps.some((s) => s.providerId === 'project-files'))
      providers.push({
        providerId: 'project-files',
        projectId: p.projectId,
        status: 'ok',
        items: [
          { label: '.vscode/settings.json restored', status: 'ok' },
          { label: 'CLAUDE.local.md restored', status: 'ok' },
          ...(mp?.name === 'looplift'
            ? [{ label: '.env.local was not included in the backup', status: 'info' as const }]
            : []),
        ],
        warnings: [],
      })
    if (p.steps.some((s) => s.providerId === 'runtime'))
      providers.push({
        providerId: 'runtime',
        projectId: p.projectId,
        status: 'ok',
        items: [
          { label: 'Node version matches .nvmrc', status: 'ok' },
          { label: 'pnpm 11.5.3 expected, 11.4.0 installed', status: 'warn' },
        ],
        warnings: [],
      })
    return { projectId: p.projectId, name: p.name, newPath: p.newPath, providers }
  })
  const attention: AttentionItem[] = [
    {
      id: 'claude-auth',
      providerId: 'claude-code',
      level: 'warn',
      title: 'Sign in to Claude Code on this Mac',
      detail: 'Credentials are never migrated. Run `claude` once and complete the sign-in.',
      action: 'reauth',
    },
    {
      id: 'pnpm-version',
      providerId: 'runtime',
      level: 'info',
      title: 'pnpm 11.5.3 expected',
      detail: 'Installed: 11.4.0. Run `corepack use pnpm@11.5.3` in each project.',
      action: 'install',
    },
    {
      id: 'env-local',
      providerId: 'project-files',
      level: 'info',
      title: 'Recreate looplift/.env.local',
      detail: 'It was excluded from the backup; fetch the values from your secrets manager.',
      action: 'manual',
    },
  ]
  return {
    planId: plan.id,
    projects,
    global:
      plan.globalSteps.length > 0
        ? [
            {
              providerId: 'claude-code',
              status: 'ok',
              items: [
                { label: 'Global settings restored', status: 'ok' },
                { label: 'History merged (1,204 entries)', status: 'ok' },
              ],
              warnings: [],
            },
          ]
        : [],
    verification: { ok: checks.every((c) => c.status !== 'fail'), checks },
    attention,
    durationMs,
    warnings: [],
  }
}

export function mockDiagnostics(generatedAt: string): Diagnostics {
  return {
    appVersion: MOCK_APP_VERSION,
    backupFormatVersion: DEVBACKUP_FORMAT_VERSION,
    electronVersion: '44.0.0',
    nodeVersion: 'v24.18.1',
    machine: mockMachine(generatedAt),
    claudeConfigDir: MOCK_CLAUDE_DIR,
    claudeConfigDirExists: true,
    claudeCodeVersion: MOCK_CLAUDE_VERSION,
    providers: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        version: '0.1.0',
        available: true,
        details: { configDir: MOCK_CLAUDE_DIR, projects: '42', encoding: 'verified' },
        notes: [],
      },
      {
        id: 'git',
        displayName: 'Git',
        version: '0.1.0',
        available: true,
        details: { git: '2.47.0' },
        notes: [],
      },
      {
        id: 'project-files',
        displayName: 'Project files',
        version: '0.1.0',
        available: true,
        details: {},
        notes: [],
      },
      {
        id: 'runtime',
        displayName: 'Runtime',
        version: '0.1.0',
        available: true,
        details: { node: '22.12.0', pnpm: '11.5.3' },
        notes: ['Informational only'],
      },
    ],
    logsDirectory: MOCK_LOGS_DIR,
    generatedAt,
  }
}
