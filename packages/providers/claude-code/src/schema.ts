/**
 * zod schemas for every untrusted file format this provider reads (Claude Code's own files and
 * this provider's payload). Loose objects keep unknown keys so rewrites never drop data.
 */
import { z } from 'zod'

export const JsonObject = z.record(z.string(), z.unknown())
export type JsonObject = z.infer<typeof JsonObject>

/** One MCP server definition (local/user scope). `env` and `headers` are where secrets live. */
export const McpServerSchema = z.looseObject({
  env: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
})
export type McpServer = z.infer<typeof McpServerSchema>

export const ClaudeJsonProjectEntrySchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
})
export type ClaudeJsonProjectEntry = z.infer<typeof ClaudeJsonProjectEntrySchema>

/** ~/.claude.json — only the parts we touch are typed; everything else is carried as unknown. */
export const ClaudeJsonSchema = z.looseObject({
  projects: z.record(z.string(), z.unknown()).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
})
export type ClaudeJson = z.infer<typeof ClaudeJsonSchema>

/** history.jsonl row (research §9). */
export const HistoryRowSchema = z.looseObject({
  display: z.string().optional(),
  timestamp: z.number().optional(),
  project: z.string().optional(),
  sessionId: z.string().optional(),
})
export type HistoryRow = z.infer<typeof HistoryRowSchema>

/** sessions/<pid>.json live registry entry (ephemeral; used to detect running Claude Code processes). */
export const SessionsRegistryEntrySchema = z.looseObject({
  pid: z.number().int().positive().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
})

/** MCP env/headers captured separately from the rest of an entry: path -> server -> {env, headers}. */
export const McpEnvMapSchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.object({
      env: z.record(z.string(), z.unknown()).optional(),
      headers: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
)
export type McpEnvMap = z.infer<typeof McpEnvMapSchema>

/** claude-json.json payload file of a project section. */
export const ProjectClaudeJsonPayloadSchema = z.object({
  projects: z.record(z.string(), z.unknown()).default({}),
  mcpEnv: McpEnvMapSchema.optional(),
})
export type ProjectClaudeJsonPayload = z.infer<typeof ProjectClaudeJsonPayloadSchema>

/** claude-json-user.json payload file of the global section. */
export const UserClaudeJsonPayloadSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
})
export type UserClaudeJsonPayload = z.infer<typeof UserClaudeJsonPayloadSchema>

export const UserMcpEnvPayloadSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({
      env: z.record(z.string(), z.unknown()).optional(),
      headers: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
})
export type UserMcpEnvPayload = z.infer<typeof UserMcpEnvPayloadSchema>

export const MatchKindSchema = z.enum(['project', 'worktree', 'claude-worktree'])
export const MatchConfidenceSchema = z.enum(['exact', 'strong', 'weak'])

export const IndexMatchSchema = z.object({
  dirName: z.string().min(1),
  kind: MatchKindSchema,
  sourcePath: z.string().min(1),
  sessionIds: z.array(z.string().min(1)),
  confidence: MatchConfidenceSchema,
})
export type IndexMatch = z.infer<typeof IndexMatchSchema>

/** index.json written at the root of every provider payload section (schema v1). */
export const BackupIndexSchema = z.object({
  schemaVersion: z.literal(1),
  section: z.enum(['project', 'global']),
  claudeCodeVersions: z.array(z.string()).default([]),
  encoding: z.object({
    rule: z.string(),
    verified: z.boolean(),
    matched: z.number().int().nonnegative(),
    mismatched: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative().default(0),
  }),
  matches: z.array(IndexMatchSchema).default([]),
  sessionCount: z.number().int().nonnegative().default(0),
  memoryDirs: z.array(z.string()).default([]),
  fileHistorySessionIds: z.array(z.string()).default([]),
  /** Names of MCP servers whose env/headers exist on the source but were NOT included (never the values). */
  mcpEnvServersExcluded: z.array(z.string()).default([]),
  project: z.object({ id: z.string(), path: z.string() }).optional(),
})
export type BackupIndex = z.infer<typeof BackupIndexSchema>

/** Artifact meta discriminators (scan -> backup). */
export const ArtifactMetaKind = z.enum([
  'sessions',
  'memory',
  'file-history',
  'session-env',
  'history',
  'claude-json-project',
  'claude-json-mcp-env',
  'project-file',
  'global-settings',
  'global-claude-md',
  'global-skills',
  'global-agents',
  'global-output-styles',
  'global-commands',
  'global-themes',
  'global-statusline',
  'global-plugins',
  'global-claude-json-user',
  'global-claude-json-user-mcp-env',
  'credential',
  'ephemeral',
])
export type ArtifactMetaKind = z.infer<typeof ArtifactMetaKind>

export const SessionsMetaSchema = z.object({
  artifactKind: z.literal('sessions'),
  dirName: z.string().min(1),
  sourceDirectory: z.string().min(1),
  sourcePath: z.string().min(1),
  kind: MatchKindSchema,
  confidence: MatchConfidenceSchema,
  sessionIds: z.array(z.string().min(1)),
  claudeVersions: z.array(z.string()).default([]),
})
export const MemoryMetaSchema = z.object({
  artifactKind: z.literal('memory'),
  dirName: z.string().min(1),
  sourceDirectory: z.string().min(1),
  sourcePath: z.string().min(1),
})
export const SessionKeyedMetaSchema = z.object({
  artifactKind: z.enum(['file-history', 'session-env']),
  root: z.string().min(1),
  sessionIds: z.array(z.string().min(1)),
})
export const HistoryMetaSchema = z.object({
  artifactKind: z.literal('history'),
  file: z.string().min(1),
  paths: z.array(z.string().min(1)),
})
export const ClaudeJsonMetaSchema = z.object({
  artifactKind: z.enum(['claude-json-project', 'claude-json-mcp-env']),
  file: z.string().min(1),
  paths: z.array(z.string().min(1)),
})
export const ProjectFileMetaSchema = z.object({
  artifactKind: z.literal('project-file'),
  absolutePath: z.string().min(1),
  relativePath: z.string().min(1),
})
export const GlobalFilesMetaSchema = z.object({
  artifactKind: z.enum([
    'global-settings',
    'global-claude-md',
    'global-skills',
    'global-agents',
    'global-output-styles',
    'global-commands',
    'global-themes',
    'global-statusline',
    'global-plugins',
  ]),
  /** Absolute source root (claudeConfigDir) the relative entries are resolved against. */
  root: z.string().min(1),
  /** Relative files/directories to copy (POSIX, relative to root). */
  entries: z.array(z.string().min(1)),
  /** Relative prefixes to exclude when copying directories (e.g. skills/synced). */
  exclude: z.array(z.string()).default([]),
})
export const GlobalClaudeJsonMetaSchema = z.object({
  artifactKind: z.enum(['global-claude-json-user', 'global-claude-json-user-mcp-env']),
  file: z.string().min(1),
})

/** Every meta shape a backup can receive. */
export const ArtifactMetaSchema = z.discriminatedUnion('artifactKind', [
  SessionsMetaSchema,
  MemoryMetaSchema,
  SessionKeyedMetaSchema,
  HistoryMetaSchema,
  ClaudeJsonMetaSchema,
  ProjectFileMetaSchema,
  GlobalFilesMetaSchema,
  GlobalClaudeJsonMetaSchema,
])
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>

/** Manifest artifact meta (backup -> restore). */
export const ManifestMetaSchema = z.object({
  artifactKind: ArtifactMetaKind,
  indexPayloadPath: z.string().min(1),
  dirName: z.string().optional(),
  sourcePath: z.string().optional(),
  kind: MatchKindSchema.optional(),
  confidence: MatchConfidenceSchema.optional(),
  sessionIds: z.array(z.string()).optional(),
  relativePath: z.string().optional(),
  entries: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  servers: z.array(z.string()).optional(),
  fileCount: z.number().int().nonnegative().optional(),
})
export type ManifestMeta = z.infer<typeof ManifestMetaSchema>

// ---------------------------------------------------------------- restore plan state

export const SessionsPlanStateSchema = z.object({
  artifactId: z.string(),
  payloadPath: z.string(),
  dirName: z.string(),
  sourcePath: z.string(),
  newCwd: z.string(),
  destDirName: z.string(),
  destDir: z.string(),
  sessionIds: z.array(z.string()),
  kind: MatchKindSchema,
  confidence: MatchConfidenceSchema,
  rewrite: z.boolean(),
  unverifiable: z.boolean(),
  collisionId: z.string().optional(),
})
export type SessionsPlanState = z.infer<typeof SessionsPlanStateSchema>

export const MemoryPlanStateSchema = z.object({
  artifactId: z.string(),
  payloadPath: z.string(),
  dirName: z.string(),
  destDir: z.string(),
  collisionId: z.string().optional(),
})
export const SessionKeyedPlanStateSchema = z.object({
  artifactId: z.string(),
  payloadPath: z.string(),
  destRoot: z.string(),
  sessionIds: z.array(z.string()),
})
export const HistoryPlanStateSchema = z.object({
  artifactId: z.string(),
  payloadPath: z.string(),
  destFile: z.string(),
})
export const ClaudeJsonPlanStateSchema = z.object({
  artifactId: z.string(),
  payloadPath: z.string(),
  destFile: z.string(),
  entries: z.array(
    z.object({ oldPath: z.string(), newPath: z.string(), collisionId: z.string().optional() }),
  ),
  includeMcpEnv: z.boolean(),
  mcpEnvArtifactId: z.string().optional(),
  fileCollisionId: z.string().optional(),
})
export const FilePlanStateSchema = z.object({
  artifactId: z.string(),
  payloadPath: z.string(),
  relativePath: z.string(),
  dest: z.string(),
  collisionId: z.string().optional(),
})
export const GlobalPlanStateSchema = z.object({
  artifactId: z.string(),
  artifactKind: ArtifactMetaKind,
  payloadPath: z.string(),
  /** Relative entries (POSIX) inside payloadPath -> destination under claudeConfigDir. */
  entries: z.array(
    z.object({
      relative: z.string(),
      dest: z.string(),
      isDirectory: z.boolean(),
      collisionId: z.string().optional(),
    }),
  ),
})
export const GlobalClaudeJsonPlanStateSchema = z.object({
  artifactId: z.string(),
  payloadPath: z.string(),
  destFile: z.string(),
  includeMcpEnv: z.boolean(),
  mcpEnvArtifactId: z.string().optional(),
  mcpEnvPayloadPath: z.string().optional(),
  serverCollisions: z.array(z.object({ name: z.string(), collisionId: z.string() })).default([]),
  fileCollisionId: z.string().optional(),
})

export const RestoreStateSchema = z.object({
  version: z.literal(1),
  section: z.enum(['project', 'global']),
  claudeConfigDir: z.string(),
  claudeJsonPath: z.string(),
  project: z
    .object({ id: z.string(), oldPath: z.string(), newPath: z.string(), pathChanged: z.boolean() })
    .optional(),
  oldPaths: z.array(z.string()).default([]),
  sessions: z.array(SessionsPlanStateSchema).default([]),
  memory: z.array(MemoryPlanStateSchema).default([]),
  fileHistory: SessionKeyedPlanStateSchema.optional(),
  sessionEnv: SessionKeyedPlanStateSchema.optional(),
  history: HistoryPlanStateSchema.optional(),
  claudeJson: ClaudeJsonPlanStateSchema.optional(),
  projectFiles: z.array(FilePlanStateSchema).default([]),
  global: z.array(GlobalPlanStateSchema).default([]),
  globalClaudeJson: GlobalClaudeJsonPlanStateSchema.optional(),
  /** Servers whose env values exist in the backup but were not selected (attention item). */
  mcpEnvServersNotRestored: z.array(z.string()).default([]),
})
export type RestoreState = z.infer<typeof RestoreStateSchema>

/** Verify state carried from restore to verify. */
export const RestoreResultStateSchema = z.object({
  sessionsWritten: z.record(z.string(), z.number().int().nonnegative()).default({}),
  sessionsSkipped: z.array(z.string()).default([]),
  memorySkipped: z.array(z.string()).default([]),
  claudeJsonEntriesWritten: z.array(z.string()).default([]),
  claudeJsonSkipped: z.boolean().default(false),
  conflictFiles: z.array(z.string()).default([]),
})
export type RestoreResultState = z.infer<typeof RestoreResultStateSchema>
