/**
 * scanProject / scanGlobal: read-only discovery of Claude Code state (research §15).
 * Every artifact carries a typed `meta` (schema.ts) that createBackupArtifacts consumes.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { classifyJsonValue } from '@devmig/core'
import type { ScanContext } from '@devmig/core'
import type {
  ProjectDescriptor,
  ProviderScanResult,
  ScannedArtifact,
  SummaryItem,
} from '@devmig/model'
import {
  MigrationError,
  canonicalizePath,
  dirSize,
  displayPath,
  stableId,
  throwIfAborted,
  walkFiles,
} from '@devmig/shared'
import { extractProjectEntries, extractUserScope, readClaudeJson } from './claude-json'
import { CLAUDE_CODE_PROVIDER_ID, EPHEMERAL_DIRS, MAX_PROJECT_CLAUDE_FILES } from './constants'
import { isExistingDirectory, isExistingFile, listDirectory, readOptionalJson } from './fs-helpers'
import { readHistoryRows } from './history'
import type { ClaudeProjectResolver, ClaudeProjectMatch } from './resolver'
import type { ArtifactMeta } from './schema'

const TRANSCRIPT_REASON =
  'Conversation transcripts are stored in plaintext by Claude Code; the backup is encrypted'
const MCP_ENV_REASON = 'MCP server environment values may contain tokens'
const CREDENTIAL_REASON = 'Re-authenticate on the destination Mac'

const SAFE_SUFFIX_RE = /^[A-Za-z0-9._-]{1,120}$/

function idSuffix(value: string): string {
  return SAFE_SUFFIX_RE.test(value) ? value : stableId(value)
}

export function projectArtifactId(projectId: string, kind: string, suffix?: string): string {
  return `${CLAUDE_CODE_PROVIDER_ID}:${projectId}:${kind}${suffix ? `:${idSuffix(suffix)}` : ''}`
}

export function globalArtifactId(kind: string, suffix?: string): string {
  return `${CLAUDE_CODE_PROVIDER_ID}:global:${kind}${suffix ? `:${idSuffix(suffix)}` : ''}`
}

type ArtifactInit = Omit<ScannedArtifact, 'providerId' | 'meta' | 'reasons' | 'selectable'> & {
  meta?: ArtifactMeta | Record<string, unknown>
  reasons?: string[]
  selectable?: boolean
}

function artifact(init: ArtifactInit): ScannedArtifact {
  return {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    selectable: true,
    reasons: [],
    meta: {},
    ...init,
  }
}

async function safeDirSize(
  dir: string,
  signal: AbortSignal | undefined,
): Promise<{ bytes: number; files: number }> {
  try {
    return await dirSize(dir, { ...(signal ? { signal } : {}), maxEntries: 500_000 })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throwIfAborted(signal)
    return { bytes: 0, files: 0 }
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.lstat(file)).size
  } catch {
    return 0
  }
}

/** Paths whose history rows / claude.json entries belong to the project: the project, its registered worktrees, Claude-managed worktrees. */
export function projectRelatedPaths(
  project: ProjectDescriptor,
  matches: readonly ClaudeProjectMatch[],
): string[] {
  const set = new Set<string>([
    canonicalizePath(project.realPath),
    canonicalizePath(project.canonicalPath),
  ])
  for (const w of project.git?.worktrees ?? []) set.add(canonicalizePath(w.path))
  for (const m of matches) set.add(canonicalizePath(m.matchedProjectPath))
  return [...set]
}

function assertSafeArgument(value: string, label: string): string {
  if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) {
    throw new MigrationError('INVALID_INPUT', `Unsafe ${label}: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Runs `git check-ignore --no-index -z --stdin` once for all candidate paths (relative to the project).
 * Returns the set of ignored relative paths, or null when the directory is not a git repository.
 */
export async function gitIgnoredPaths(
  project: ProjectDescriptor,
  relativePaths: readonly string[],
  ctx: Pick<ScanContext, 'exec' | 'signal' | 'env' | 'logger'>,
): Promise<Set<string> | null> {
  if (!project.git || relativePaths.length === 0) return null
  for (const rel of relativePaths) assertSafeArgument(rel, 'path')
  const result = await ctx.exec('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: project.realPath,
    env: ctx.env,
    signal: ctx.signal,
    reject: false,
    timeoutMs: 30_000,
    input: `${relativePaths.join('\0')}\0`,
  })
  if (result.exitCode === 0 || result.exitCode === 1) {
    return new Set(result.stdout.split('\0').filter((p) => p.length > 0))
  }
  ctx.logger.warn('git check-ignore failed; treating project as non-git', {
    exitCode: result.exitCode,
    stderr: result.stderr.slice(0, 500),
  })
  return null
}

interface ProjectSideFile {
  relativePath: string
  absolutePath: string
  sizeBytes: number
}

const ALWAYS_INCLUDED_PROJECT_FILES = new Set(['.claude/settings.local.json', 'CLAUDE.local.md'])
const NEVER_INCLUDED_PROJECT_FILES = new Set(['.claude/scheduled_tasks.lock'])

async function listProjectSideFiles(
  project: ProjectDescriptor,
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<ProjectSideFile[]> {
  const root = project.realPath
  const files: ProjectSideFile[] = []
  const push = async (rel: string): Promise<void> => {
    const abs = path.join(root, rel)
    if (await isExistingFile(abs))
      files.push({ relativePath: rel, absolutePath: abs, sizeBytes: await fileSize(abs) })
  }
  await push('CLAUDE.local.md')
  await push('.mcp.json')
  const claudeDir = path.join(root, '.claude')
  if (await isExistingDirectory(claudeDir)) {
    try {
      for await (const entry of walkFiles(claudeDir, {
        ...(signal ? { signal } : {}),
        maxEntries: MAX_PROJECT_CLAUDE_FILES,
        filter: (rel, dirent) => {
          if (rel === 'worktrees' && dirent.isDirectory()) return false
          if (dirent.isSymbolicLink()) return false
          return !rel.endsWith('.lock')
        },
      })) {
        if (!entry.dirent.isFile()) continue
        const rel = `.claude/${entry.relativePath}`
        if (NEVER_INCLUDED_PROJECT_FILES.has(rel)) continue
        files.push({
          relativePath: rel,
          absolutePath: entry.absolutePath,
          sizeBytes: entry.sizeBytes,
        })
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throwIfAborted(signal)
      warnings.push(
        `Too many files under ${displayPath(claudeDir)}; only the first ${MAX_PROJECT_CLAUDE_FILES} were considered.`,
      )
    }
  }
  return files
}

export interface ScanProjectDeps {
  resolver: ClaudeProjectResolver
  platform: NodeJS.Platform
}

export async function scanProject(
  project: ProjectDescriptor,
  ctx: ScanContext,
  deps: ScanProjectDeps,
): Promise<ProviderScanResult> {
  const artifacts: ScannedArtifact[] = []
  const summary: SummaryItem[] = []
  const warnings: string[] = []
  const configDirExists = await isExistingDirectory(ctx.claudeConfigDir)
  ctx.progress('Matching Claude Code project directories…')

  const resolved = configDirExists
    ? await deps.resolver.resolve(project, {
        claudeConfigDir: ctx.claudeConfigDir,
        claudeJsonPath: ctx.claudeJsonPath,
        allProjects: ctx.allProjects,
        signal: ctx.signal,
        logger: ctx.logger,
      })
    : { matches: [], warnings: [], encodingSamples: [] }
  warnings.push(...resolved.warnings)
  const matches = resolved.matches
  let sessionCount = 0
  let worktreeSets = 0
  let weakMatches = 0

  // ---- sessions + memory per match ----
  for (const match of matches) {
    throwIfAborted(ctx.signal)
    const includedByDefault = match.confidence !== 'weak'
    if (match.confidence === 'weak') weakMatches += 1
    if (match.kind === 'claude-worktree') worktreeSets += 1
    if (includedByDefault) sessionCount += match.sessionCount
    const kindLabel =
      match.kind === 'project'
        ? ''
        : match.kind === 'worktree'
          ? ' · worktree'
          : ' · Claude worktree'
    artifacts.push(
      artifact({
        id: projectArtifactId(project.id, 'sessions', match.dirName),
        projectId: project.id,
        scope: 'project',
        kind: 'file-set',
        label: `Claude Code sessions (${match.sessionCount})${kindLabel}`,
        description: `${displayPath(match.matchedProjectPath, ctx.homeDir)} — ${match.confidence} match`,
        sourcePath: displayPath(match.sourceDirectory, ctx.homeDir),
        sizeBytes: match.sizeBytes,
        count: match.sessionCount,
        sensitivity: 'safe',
        includedByDefault,
        reasons: [
          TRANSCRIPT_REASON,
          ...(match.confidence === 'weak'
            ? ['Weak match (name only) — review before including']
            : []),
          ...match.evidence,
        ],
        meta: {
          artifactKind: 'sessions',
          dirName: match.dirName,
          sourceDirectory: match.sourceDirectory,
          sourcePath: match.matchedProjectPath,
          kind: match.kind,
          confidence: match.confidence,
          sessionIds: match.sessionIds,
          claudeVersions: match.claudeVersions,
        },
      }),
    )
    if (match.hasMemory) {
      const memoryDir = path.join(match.sourceDirectory, 'memory')
      const size = await safeDirSize(memoryDir, ctx.signal)
      artifacts.push(
        artifact({
          id: projectArtifactId(project.id, 'memory', match.dirName),
          projectId: project.id,
          scope: 'project',
          kind: 'directory',
          label: 'Claude Code project memory',
          description: `Auto memory for ${displayPath(match.matchedProjectPath, ctx.homeDir)}`,
          sourcePath: displayPath(memoryDir, ctx.homeDir),
          sizeBytes: size.bytes,
          count: size.files,
          sensitivity: 'safe',
          includedByDefault,
          meta: {
            artifactKind: 'memory',
            dirName: match.dirName,
            sourceDirectory: memoryDir,
            sourcePath: match.matchedProjectPath,
          },
        }),
      )
    }
  }

  const allSessionIds = [
    ...new Set(matches.filter((m) => m.confidence !== 'weak').flatMap((m) => m.sessionIds)),
  ]
  const relatedPaths = projectRelatedPaths(project, matches)

  // ---- file-history / session-env keyed by session id ----
  for (const [kind, folder, label] of [
    ['file-history', 'file-history', 'Claude Code checkpoints (file history)'],
    ['session-env', 'session-env', 'Claude Code session environment'],
  ] as const) {
    const root = path.join(ctx.claudeConfigDir, folder)
    const present: string[] = []
    let bytes = 0
    let files = 0
    for (const sid of allSessionIds) {
      throwIfAborted(ctx.signal)
      const dir = path.join(root, sid)
      if (!(await isExistingDirectory(dir))) continue
      const size = await safeDirSize(dir, ctx.signal)
      present.push(sid)
      bytes += size.bytes
      files += size.files
    }
    if (present.length === 0) continue
    artifacts.push(
      artifact({
        id: projectArtifactId(project.id, kind),
        projectId: project.id,
        scope: 'project',
        kind: 'file-set',
        label: `${label} (${present.length} sessions)`,
        sourcePath: displayPath(root, ctx.homeDir),
        sizeBytes: bytes,
        count: files,
        sensitivity: 'safe',
        includedByDefault: true,
        reasons:
          kind === 'file-history'
            ? ['Needed for /rewind in restored sessions']
            : ['Small hook-generated environment scripts; regenerated by Claude Code when missing'],
        meta: { artifactKind: kind, root, sessionIds: present },
      }),
    )
  }

  // ---- history.jsonl rows ----
  const historyFile = path.join(ctx.claudeConfigDir, 'history.jsonl')
  if (await isExistingFile(historyFile)) {
    let rows = 0
    let bytes = 0
    for await (const line of readHistoryRows(historyFile, {
      paths: relatedPaths,
      signal: ctx.signal,
    })) {
      rows += 1
      bytes += Buffer.byteLength(line.text, 'utf8') + 1
    }
    if (rows > 0) {
      artifacts.push(
        artifact({
          id: projectArtifactId(project.id, 'history'),
          projectId: project.id,
          scope: 'project',
          kind: 'json-fragment',
          label: `Claude Code prompt history (${rows} entries)`,
          sourcePath: displayPath(historyFile, ctx.homeDir),
          sizeBytes: bytes,
          count: rows,
          sensitivity: 'safe',
          includedByDefault: true,
          meta: { artifactKind: 'history', file: historyFile, paths: relatedPaths },
        }),
      )
    }
  }

  // ---- ~/.claude.json project entries ----
  try {
    const json = await readClaudeJson(ctx.claudeJsonPath)
    const extracted = extractProjectEntries(json, relatedPaths)
    const entryPaths = Object.keys(extracted.projects)
    if (entryPaths.length > 0) {
      artifacts.push(
        artifact({
          id: projectArtifactId(project.id, 'claude-json:project'),
          projectId: project.id,
          scope: 'project',
          kind: 'json-fragment',
          label: `Claude Code project settings (${entryPaths.length} entr${entryPaths.length === 1 ? 'y' : 'ies'})`,
          description:
            'Allowed tools, MCP approvals and trust state from ~/.claude.json (MCP env values excluded)',
          sourcePath: displayPath(ctx.claudeJsonPath, ctx.homeDir),
          sizeBytes: Buffer.byteLength(JSON.stringify(extracted.projects), 'utf8'),
          count: entryPaths.length,
          sensitivity: 'safe',
          includedByDefault: true,
          meta: {
            artifactKind: 'claude-json-project',
            file: ctx.claudeJsonPath,
            paths: entryPaths,
          },
        }),
      )
      const envPaths = Object.keys(extracted.mcpEnv)
      if (envPaths.length > 0) {
        const servers = [
          ...new Set(envPaths.flatMap((p) => Object.keys(extracted.mcpEnv[p] ?? {}))),
        ]
        artifacts.push(
          artifact({
            id: projectArtifactId(project.id, 'claude-json:mcp-env'),
            projectId: project.id,
            scope: 'project',
            kind: 'json-fragment',
            label: `MCP server environment values (${servers.join(', ')})`,
            description: 'env/headers blocks of project-local MCP servers in ~/.claude.json',
            sourcePath: displayPath(ctx.claudeJsonPath, ctx.homeDir),
            count: servers.length,
            sensitivity: 'sensitive',
            includedByDefault: false,
            reasons: [MCP_ENV_REASON],
            meta: {
              artifactKind: 'claude-json-mcp-env',
              file: ctx.claudeJsonPath,
              paths: envPaths,
            },
          }),
        )
      }
    }
  } catch (err) {
    warnings.push(
      `Could not read ${displayPath(ctx.claudeJsonPath, ctx.homeDir)}: ${(err as Error).message}`,
    )
  }

  // ---- project-side files ----
  const sideFiles = await listProjectSideFiles(project, ctx.signal, warnings)
  const ignored = await gitIgnoredPaths(
    project,
    sideFiles.map((f) => f.relativePath),
    ctx,
  )
  let carriedByGit = 0
  for (const file of sideFiles) {
    throwIfAborted(ctx.signal)
    const always = ALWAYS_INCLUDED_PROJECT_FILES.has(file.relativePath)
    const isIgnored = ignored === null || ignored.has(file.relativePath)
    if (!always && !isIgnored) {
      carriedByGit += 1
      continue
    }
    let sensitivity: ScannedArtifact['sensitivity'] = 'safe'
    const reasons: string[] = []
    if (file.relativePath === '.mcp.json') {
      try {
        const hits = classifyJsonValue(await readOptionalJson(file.absolutePath))
        if (hits.length > 0) {
          sensitivity = 'sensitive'
          reasons.push(...hits.slice(0, 3).map((h) => `${h.path}: ${h.reason}`))
        }
      } catch {
        reasons.push('.mcp.json could not be parsed')
      }
    }
    if (always && !isIgnored)
      reasons.push('Not ignored by Git; the Git working tree state may carry it too')
    artifacts.push(
      artifact({
        id: projectArtifactId(project.id, 'project-file', file.relativePath),
        projectId: project.id,
        scope: 'project',
        kind: 'file',
        label: file.relativePath,
        sourcePath: displayPath(file.absolutePath, ctx.homeDir),
        sizeBytes: file.sizeBytes,
        sensitivity,
        includedByDefault: sensitivity === 'safe',
        reasons,
        meta: {
          artifactKind: 'project-file',
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
        },
      }),
    )
  }

  // ---- summary ----
  if (!configDirExists) {
    summary.push({
      label: 'Claude Code data directory not found',
      status: 'info',
      detail: displayPath(ctx.claudeConfigDir, ctx.homeDir),
    })
  }
  summary.push({
    label: sessionCount > 0 ? `${sessionCount} sessions` : 'no sessions',
    status: sessionCount > 0 ? 'ok' : 'info',
  })
  if (artifacts.some((a) => (a.meta as { artifactKind?: string }).artifactKind === 'memory')) {
    summary.push({ label: 'project memory', status: 'ok' })
  }
  for (const rel of ALWAYS_INCLUDED_PROJECT_FILES) {
    if (sideFiles.some((f) => f.relativePath === rel)) summary.push({ label: rel, status: 'ok' })
  }
  if (worktreeSets > 0) {
    summary.push({
      label: `${worktreeSets} orphaned worktree session set${worktreeSets === 1 ? '' : 's'}`,
      status: 'warn',
      detail:
        'Sessions of Claude-managed worktrees resume in the project directory when the worktree is gone',
    })
  }
  if (weakMatches > 0) {
    summary.push({
      label: `${weakMatches} weak match${weakMatches === 1 ? '' : 'es'} need review`,
      status: 'warn',
    })
  }
  if (carriedByGit > 0) {
    summary.push({
      label: `${carriedByGit} file${carriedByGit === 1 ? '' : 's'} under .claude are carried by Git`,
      status: 'info',
    })
  }
  const estimatedBytes = artifacts
    .filter((a) => a.includedByDefault)
    .reduce((n, a) => n + (a.sizeBytes ?? 0), 0)
  return {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    projectId: project.id,
    detected: artifacts.length > 0,
    artifacts,
    summary,
    warnings,
    estimatedBytes,
  }
}

// ---------------------------------------------------------------- global scan

interface GlobalFileSet {
  kind:
    | 'global-settings'
    | 'global-claude-md'
    | 'global-skills'
    | 'global-agents'
    | 'global-output-styles'
    | 'global-commands'
    | 'global-themes'
    | 'global-statusline'
    | 'global-plugins'
  id: string
  label: string
  entries: string[]
  exclude?: string[]
  reasons?: string[]
}

const GLOBAL_FILE_SETS: GlobalFileSet[] = [
  {
    kind: 'global-settings',
    id: 'settings',
    label: 'Claude Code settings',
    entries: ['settings.json', 'settings.local.json', 'keybindings.json'],
  },
  {
    kind: 'global-claude-md',
    id: 'claude-md',
    label: 'User CLAUDE.md and rules',
    entries: ['CLAUDE.md', 'rules'],
  },
  {
    kind: 'global-skills',
    id: 'skills',
    label: 'Skills',
    entries: ['skills'],
    exclude: ['skills/synced'],
  },
  { kind: 'global-agents', id: 'agents', label: 'Agents', entries: ['agents'] },
  {
    kind: 'global-output-styles',
    id: 'output-styles',
    label: 'Output styles',
    entries: ['output-styles'],
  },
  { kind: 'global-commands', id: 'commands', label: 'Commands', entries: ['commands'] },
  { kind: 'global-themes', id: 'themes', label: 'Themes', entries: ['themes'] },
  {
    kind: 'global-statusline',
    id: 'statusline',
    label: 'Status line script',
    entries: ['statusline-command.sh'],
  },
  {
    kind: 'global-plugins',
    id: 'plugins-manifest',
    label: 'Plugins manifest and plugin data',
    entries: ['plugins/installed_plugins.json', 'plugins/known_marketplaces.json', 'plugins/data'],
    reasons: ['Plugin caches are not copied; plugins are re-fetched by Claude Code'],
  },
]

export async function scanGlobal(
  ctx: ScanContext,
  deps: ScanProjectDeps,
): Promise<ProviderScanResult> {
  const artifacts: ScannedArtifact[] = []
  const summary: SummaryItem[] = []
  const warnings: string[] = []
  const root = ctx.claudeConfigDir
  const configDirExists = await isExistingDirectory(root)
  ctx.progress('Scanning user-wide Claude Code state…')

  if (configDirExists) {
    for (const set of GLOBAL_FILE_SETS) {
      throwIfAborted(ctx.signal)
      const present: string[] = []
      let bytes = 0
      let files = 0
      for (const rel of set.entries) {
        const abs = path.join(root, rel)
        if (await isExistingFile(abs)) {
          present.push(rel)
          bytes += await fileSize(abs)
          files += 1
        } else if (await isExistingDirectory(abs)) {
          const size = await dirSize(abs, {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            filter: (childRel) =>
              !(set.exclude ?? []).some(
                (ex) => `${rel}/${childRel}` === ex || `${rel}/${childRel}`.startsWith(`${ex}/`),
              ),
          })
          if (size.files === 0) continue
          present.push(rel)
          bytes += size.bytes
          files += size.files
        }
      }
      if (present.length === 0) continue
      artifacts.push(
        artifact({
          id: globalArtifactId(set.id),
          scope: 'user',
          kind:
            set.entries.length === 1 &&
            present[0] &&
            !present[0].includes('/') &&
            present[0].includes('.')
              ? 'file'
              : 'file-set',
          label: set.label,
          sourcePath: displayPath(root, ctx.homeDir),
          sizeBytes: bytes,
          count: files,
          sensitivity: 'safe',
          includedByDefault: true,
          reasons: set.reasons ?? [],
          meta: { artifactKind: set.kind, root, entries: present, exclude: set.exclude ?? [] },
        }),
      )
      summary.push({ label: set.label, status: 'ok', detail: present.join(', ') })
    }

    // ephemeral listing (transparency only)
    for (const name of EPHEMERAL_DIRS) {
      const abs = path.join(root, name)
      if (!(await isExistingDirectory(abs))) continue
      const size = await safeDirSize(abs, ctx.signal)
      artifacts.push(
        artifact({
          id: globalArtifactId('ephemeral', name),
          scope: 'ephemeral',
          kind: 'directory',
          label: `${name}/`,
          sourcePath: displayPath(abs, ctx.homeDir),
          sizeBytes: size.bytes,
          count: size.files,
          sensitivity: name === 'sessions' ? 'credential' : 'safe',
          includedByDefault: false,
          selectable: false,
          reasons: ['Machine-local state that Claude Code regenerates; never migrated'],
          meta: { artifactKind: 'ephemeral' },
        }),
      )
    }
    const sessionKeys = (await listDirectory(path.join(root, 'sessions'))).filter(
      (e) => e.isFile() && e.name.endsWith('.key'),
    )
    if (sessionKeys.length > 0) {
      artifacts.push(
        artifact({
          id: globalArtifactId('credential', 'sessions-keys'),
          scope: 'user',
          kind: 'file-set',
          label: 'Live session peer tokens (sessions/*.key)',
          sourcePath: displayPath(path.join(root, 'sessions'), ctx.homeDir),
          count: sessionKeys.length,
          sensitivity: 'credential',
          includedByDefault: false,
          selectable: false,
          reasons: [CREDENTIAL_REASON],
          meta: { artifactKind: 'credential' },
        }),
      )
    }
  } else {
    summary.push({
      label: 'Claude Code data directory not found',
      status: 'info',
      detail: displayPath(root, ctx.homeDir),
    })
  }

  // ~/.claude.json user scope
  try {
    const json = await readClaudeJson(ctx.claudeJsonPath)
    if (json) {
      const user = extractUserScope(json)
      const serverNames = Object.keys(user.mcpServers)
      const configKeys = Object.keys(user.config)
      if (serverNames.length > 0 || configKeys.length > 0) {
        artifacts.push(
          artifact({
            id: globalArtifactId('claude-json:user'),
            scope: 'user',
            kind: 'json-fragment',
            label: 'User-scope MCP servers and global config',
            description: [
              serverNames.length > 0 ? `MCP servers: ${serverNames.join(', ')}` : undefined,
              configKeys.length > 0 ? `config keys: ${configKeys.join(', ')}` : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
            sourcePath: displayPath(ctx.claudeJsonPath, ctx.homeDir),
            count: serverNames.length + configKeys.length,
            sizeBytes: Buffer.byteLength(
              JSON.stringify({ mcpServers: user.mcpServers, config: user.config }),
              'utf8',
            ),
            sensitivity: 'safe',
            includedByDefault: true,
            reasons: ['MCP env/headers values are captured separately'],
            meta: { artifactKind: 'global-claude-json-user', file: ctx.claudeJsonPath },
          }),
        )
        summary.push({ label: 'user MCP servers / global config', status: 'ok' })
      }
      const envServers = Object.keys(user.mcpEnv)
      if (envServers.length > 0) {
        artifacts.push(
          artifact({
            id: globalArtifactId('claude-json:user-mcp-env'),
            scope: 'user',
            kind: 'json-fragment',
            label: `User MCP server environment values (${envServers.join(', ')})`,
            sourcePath: displayPath(ctx.claudeJsonPath, ctx.homeDir),
            count: envServers.length,
            sensitivity: 'sensitive',
            includedByDefault: false,
            reasons: [MCP_ENV_REASON],
            meta: { artifactKind: 'global-claude-json-user-mcp-env', file: ctx.claudeJsonPath },
          }),
        )
      }
      if (Object.hasOwn(json, 'oauthAccount')) {
        artifacts.push(
          artifact({
            id: globalArtifactId('credential', 'oauth-account'),
            scope: 'user',
            kind: 'json-fragment',
            label: 'Claude account identity (oauthAccount)',
            sourcePath: displayPath(ctx.claudeJsonPath, ctx.homeDir),
            sensitivity: 'credential',
            includedByDefault: false,
            selectable: false,
            reasons: [CREDENTIAL_REASON],
            meta: { artifactKind: 'credential' },
          }),
        )
      }
    } else {
      summary.push({ label: '~/.claude.json not found', status: 'info' })
    }
  } catch (err) {
    warnings.push(
      `Could not read ${displayPath(ctx.claudeJsonPath, ctx.homeDir)}: ${(err as Error).message}`,
    )
  }
  if (deps.platform === 'darwin') {
    artifacts.push(
      artifact({
        id: globalArtifactId('credential', 'keychain'),
        scope: 'user',
        kind: 'derived',
        label: 'Keychain item "Claude Code-credentials"',
        sensitivity: 'credential',
        includedByDefault: false,
        selectable: false,
        reasons: [CREDENTIAL_REASON],
        meta: { artifactKind: 'credential' },
      }),
    )
  }
  const estimatedBytes = artifacts
    .filter((a) => a.includedByDefault)
    .reduce((n, a) => n + (a.sizeBytes ?? 0), 0)
  return {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    detected: artifacts.some((a) => a.selectable),
    artifacts,
    summary,
    warnings,
    estimatedBytes,
  }
}
