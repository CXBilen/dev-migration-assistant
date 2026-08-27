/**
 * zod schemas for everything this provider reads back from untrusted places: artifact meta carried
 * through the scan session and the manifest, index.json inside the payload, and the plan/restore state.
 */
import { Sensitivity } from '@devmig/model'
import { z } from 'zod'
import { isSafeRelpath } from './candidates'

const CandidateCategorySchema = z.enum([
  'env',
  'direnv',
  'package-manager',
  'version-pin',
  'compose',
  'certificate',
])

const SafeRelpath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => isSafeRelpath(p), 'Relative path must be a safe archive path')

const AbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), 'Must be an absolute POSIX path')

const Mode = z.number().int().min(0).max(0o777)
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)

/** ScannedArtifact.meta for one candidate file (written by scanProject, read by createBackupArtifacts). */
export const ScannedFileMeta = z.object({
  relpath: SafeRelpath,
  worktreeIndex: z.number().int().nonnegative(),
  worktreeRoot: AbsolutePath,
  absPath: AbsolutePath,
  mode: Mode,
  sizeBytes: z.number().int().nonnegative(),
  category: CandidateCategorySchema,
  /** What the classifier said before any downgrade (credential-class files are stored as 'sensitive'). */
  classification: Sensitivity,
  gitStatus: z.enum(['ignored', 'captured-by-git', 'unknown', 'not-a-repo']),
})
export type ScannedFileMeta = z.infer<typeof ScannedFileMeta>

/** ManifestArtifact.meta for one restored file (written by createBackupArtifacts, read by planRestore). */
export const ManifestFileMeta = z.object({
  relpath: SafeRelpath,
  worktreeIndex: z.number().int().nonnegative(),
  worktreeRoot: AbsolutePath,
  mode: Mode,
  sha256: Sha256,
  category: CandidateCategorySchema,
  classification: Sensitivity,
  /** Payload-relative path of the provider's index.json. */
  indexPath: z.string().min(1),
})
export type ManifestFileMeta = z.infer<typeof ManifestFileMeta>

export const IndexEntry = z.object({
  relpath: SafeRelpath,
  worktreeIndex: z.number().int().nonnegative(),
  worktreeRoot: AbsolutePath,
  payloadPath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: Sha256,
  sensitivity: Sensitivity,
  mode: Mode,
  category: CandidateCategorySchema,
})
export type IndexEntry = z.infer<typeof IndexEntry>

export const ProjectFilesIndex = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  files: z.array(IndexEntry),
})
export type ProjectFilesIndex = z.infer<typeof ProjectFilesIndex>

export const PlannedFile = z.object({
  artifactId: z.string().min(1),
  payloadPath: z.string().min(1),
  relpath: SafeRelpath,
  worktreeIndex: z.number().int().nonnegative(),
  destinationRoot: AbsolutePath,
  destination: AbsolutePath,
  pathChanged: z.boolean(),
  collisionId: z.string().min(1).optional(),
  sha256: Sha256,
  sizeBytes: z.number().int().nonnegative(),
  mode: Mode,
  sensitivity: Sensitivity,
})
export type PlannedFile = z.infer<typeof PlannedFile>

export const PlanState = z.object({
  files: z.array(PlannedFile),
})
export type PlanState = z.infer<typeof PlanState>

export const WrittenFile = z.object({
  artifactId: z.string().min(1),
  relpath: SafeRelpath,
  destination: AbsolutePath,
  sha256: Sha256,
  mode: Mode,
  sensitivity: Sensitivity,
  /** Present when an existing file was moved aside (backup-then-replace). */
  backupPath: AbsolutePath.optional(),
})
export type WrittenFile = z.infer<typeof WrittenFile>

export const SkippedFile = z.object({
  artifactId: z.string().min(1),
  relpath: SafeRelpath,
  destination: AbsolutePath,
  reason: z.string(),
})
export type SkippedFile = z.infer<typeof SkippedFile>

export const RestoreState = z.object({
  written: z.array(WrittenFile).default([]),
  skipped: z.array(SkippedFile).default([]),
  failed: z.array(SkippedFile).default([]),
})
export type RestoreState = z.infer<typeof RestoreState>
