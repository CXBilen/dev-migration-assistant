import { z } from 'zod'
import { IsoDate, ProjectId } from './ids'
import { InstallMethod } from './machine'

export const CAPABILITY_SNAPSHOT_VERSION = 1 as const

/** One executable the app looked for. No hostnames, no secrets. */
export const ToolCapability = z.object({
  id: z.string().min(1),
  label: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
  installMethod: InstallMethod.nullable(),
  /** Recipe that owns this tool (Phase B); absent for the built-in probes. */
  recipeId: z.string().optional(),
})
export type ToolCapability = z.infer<typeof ToolCapability>

export const IntegrationKind = z.enum(['cli-auth', 'mcp-server', 'plugin', 'connector'])
export type IntegrationKind = z.infer<typeof IntegrationKind>

export const IntegrationScope = z.enum(['user', 'project', 'plugin', 'claude.ai', 'machine'])
export type IntegrationScope = z.infer<typeof IntegrationScope>

export const McpTransport = z.enum(['stdio', 'http', 'sse'])
export type McpTransport = z.infer<typeof McpTransport>

/** What the source machine knew about its sign-in state when the backup was made. */
export const SourceSignInState = z.enum(['signed-in', 'signed-out', 'unknown'])
export type SourceSignInState = z.infer<typeof SourceSignInState>

/**
 * An authentication relationship or integration that must be re-established on the destination.
 * Carries names, transport and location only — never env values, headers, args or tokens.
 */
export const IntegrationRecord = z.object({
  id: z.string().min(1),
  recipeId: z.string().min(1),
  kind: IntegrationKind,
  name: z.string().min(1),
  scope: IntegrationScope,
  projectId: ProjectId.optional(),
  transport: McpTransport.optional(),
  /** Executable basename of a stdio server (never its args). */
  command: z.string().optional(),
  /** Origin + path of an http/sse server (query and userinfo stripped). */
  url: z.string().optional(),
  requiresSignIn: z.boolean(),
  sourceSignIn: SourceSignInState.default('unknown'),
})
export type IntegrationRecord = z.infer<typeof IntegrationRecord>

export const PluginRecord = z.object({
  id: z.string().min(1),
  marketplace: z.string().min(1),
  version: z.string().nullable(),
  enabled: z.boolean(),
})
export type PluginRecord = z.infer<typeof PluginRecord>

export const MarketplaceRecord = z.object({
  name: z.string().min(1),
  source: z.object({ source: z.string(), repo: z.string().optional() }),
})
export type MarketplaceRecord = z.infer<typeof MarketplaceRecord>

export const ClaudeCapability = z.object({
  version: z.string().nullable(),
  installMethod: InstallMethod.nullable(),
  /** Claude Code versions that wrote the transcripts in the backup (from provider summaries). */
  transcriptWriterVersions: z.array(z.string()).default([]),
})
export type ClaudeCapability = z.infer<typeof ClaudeCapability>

/** Capability snapshot: tools, integrations and plugins of one machine. Contains no secrets. */
export const CapabilitySnapshot = z.object({
  schemaVersion: z.literal(CAPABILITY_SNAPSHOT_VERSION),
  capturedAt: IsoDate,
  role: z.enum(['source', 'destination']),
  search: z.object({ paths: z.array(z.string()) }),
  tools: z.array(ToolCapability),
  integrations: z.array(IntegrationRecord).default([]),
  plugins: z.array(PluginRecord).default([]),
  marketplaces: z.array(MarketplaceRecord).default([]),
  claude: ClaudeCapability,
})
export type CapabilitySnapshot = z.infer<typeof CapabilitySnapshot>
