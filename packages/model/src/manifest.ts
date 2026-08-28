import { z } from 'zod'
import { ArtifactKind, Sensitivity } from './artifacts'
import { CapabilitySnapshot } from './capabilities'
import { ArtifactId, IsoDate, ProjectId, ProviderId } from './ids'
import { MachineInfo } from './machine'
import { ProjectGitInfo } from './project'

export const DEVBACKUP_FORMAT = 'devbackup' as const
export const DEVBACKUP_FORMAT_VERSION = 1 as const

/** One artifact stored in the payload. payloadPath is relative to the payload root, POSIX separators. */
export const ManifestArtifact = z.object({
  id: ArtifactId,
  providerId: ProviderId,
  kind: ArtifactKind,
  label: z.string(),
  payloadPath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Number of files under payloadPath for directory / file-set artifacts. */
  fileCount: z.number().int().nonnegative().optional(),
  sensitivity: Sensitivity,
  /** Original absolute source path on the source machine (for path mapping), when applicable. */
  sourcePath: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type ManifestArtifact = z.infer<typeof ManifestArtifact>

export const ManifestProviderSection = z.object({
  providerId: ProviderId,
  schemaVersion: z.number().int().positive(),
  artifacts: z.array(ManifestArtifact),
  /** Provider-defined summary for display (counts, branch, etc.). No secrets. */
  summary: z.record(z.string(), z.unknown()).default({}),
})
export type ManifestProviderSection = z.infer<typeof ManifestProviderSection>

export const ManifestProject = z.object({
  id: ProjectId,
  name: z.string(),
  originalPath: z.string(),
  canonicalPath: z.string(),
  git: ProjectGitInfo.optional(),
  providers: z.array(ManifestProviderSection),
})
export type ManifestProject = z.infer<typeof ManifestProject>

export const ManifestStats = z.object({
  projectCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  payloadBytes: z.number().int().nonnegative(),
  claudeSessionCount: z.number().int().nonnegative().default(0),
  worktreeCount: z.number().int().nonnegative().default(0),
})
export type ManifestStats = z.infer<typeof ManifestStats>

/** manifest.json — the first entry of the payload. Encrypted along with everything else. */
export const Manifest = z.object({
  format: z.literal(DEVBACKUP_FORMAT),
  formatVersion: z.number().int().positive(),
  id: z.string(),
  label: z.string(),
  createdAt: IsoDate,
  appVersion: z.string(),
  machine: MachineInfo,
  /** provider id -> provider payload schema version */
  providers: z.record(ProviderId, z.number().int().positive()),
  projects: z.array(ManifestProject),
  /** User-scoped sections (Global Claude Code Environment etc.). */
  global: z.array(ManifestProviderSection).default([]),
  stats: ManifestStats,
  /** Free-form hints for the restore planner (e.g. verified Claude dir-name encoding). No secrets. */
  restoreHints: z.record(z.string(), z.unknown()).default({}),
  /** Source capability snapshot (v0.2+): tools, integrations, plugins — names only, no secrets. */
  capabilities: CapabilitySnapshot.optional(),
})
export type Manifest = z.infer<typeof Manifest>

/** checksums.json — the last entry of the payload. */
export const ChecksumEntry = z.object({
  path: z.string(),
  sha256: z.string().length(64),
  sizeBytes: z.number().int().nonnegative(),
})
export type ChecksumEntry = z.infer<typeof ChecksumEntry>
export const Checksums = z.object({
  algorithm: z.literal('sha256'),
  entries: z.array(ChecksumEntry),
})
export type Checksums = z.infer<typeof Checksums>
