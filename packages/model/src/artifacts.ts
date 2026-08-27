import { z } from 'zod'
import { ArtifactId, ProjectId, ProviderId } from './ids'

/** Security classification of an artifact. */
export const Sensitivity = z.enum([
  /** No secrets expected (e.g. .nvmrc, transcripts metadata). */
  'safe',
  /** May contain secrets (e.g. .env.local, MCP env blocks, transcripts that echoed a token). */
  'sensitive',
  /** Is an authentication credential (OAuth tokens, session keys). Never migrated by default; re-auth on destination. */
  'credential',
])
export type Sensitivity = z.infer<typeof Sensitivity>

export const ArtifactScope = z.enum([
  /** Belongs to a selected project (or one of its worktrees). */
  'project',
  /** User-wide state ("Global Claude Code Environment"). */
  'user',
  /** Machine/process-local, never worth migrating (locks, pids, caches). Shown for transparency only. */
  'ephemeral',
])
export type ArtifactScope = z.infer<typeof ArtifactScope>

export const ArtifactKind = z.enum(['file', 'directory', 'file-set', 'derived', 'json-fragment'])
export type ArtifactKind = z.infer<typeof ArtifactKind>

/**
 * Something a provider found during scan that can be included in a backup.
 * Artifact ids are stable within a scan session and are what the user selects.
 */
export const ScannedArtifact = z.object({
  id: ArtifactId,
  providerId: ProviderId,
  projectId: ProjectId.optional(),
  scope: ArtifactScope,
  kind: ArtifactKind,
  /** Short human label, e.g. "Claude Code sessions (187)". */
  label: z.string(),
  description: z.string().optional(),
  /** Display path (may be abbreviated with ~). */
  sourcePath: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  /** Number of files/sessions/items represented. */
  count: z.number().int().nonnegative().optional(),
  sensitivity: Sensitivity,
  includedByDefault: z.boolean(),
  /** False for items shown for transparency but not selectable (e.g. ephemeral state). */
  selectable: z.boolean().default(true),
  /** Why it was classified this way / why excluded by default. */
  reasons: z.array(z.string()).default([]),
  /** Provider-private data needed to produce the artifact at backup time (paths, ids). Must not contain secrets. */
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type ScannedArtifact = z.infer<typeof ScannedArtifact>

export const StatusLevel = z.enum(['ok', 'info', 'warn', 'error'])
export type StatusLevel = z.infer<typeof StatusLevel>

/** One line in the human-readable scan summary ("✓ main @ abc123", "! 4 modified files"). */
export const SummaryItem = z.object({
  label: z.string(),
  status: StatusLevel,
  detail: z.string().optional(),
})
export type SummaryItem = z.infer<typeof SummaryItem>

export const ProviderScanResult = z.object({
  providerId: ProviderId,
  projectId: ProjectId.optional(),
  /** Whether the provider found anything relevant at all. */
  detected: z.boolean(),
  artifacts: z.array(ScannedArtifact),
  summary: z.array(SummaryItem).default([]),
  warnings: z.array(z.string()).default([]),
  estimatedBytes: z.number().int().nonnegative().default(0),
})
export type ProviderScanResult = z.infer<typeof ProviderScanResult>
