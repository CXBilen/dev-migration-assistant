import { z } from 'zod'
import { ArtifactId } from './ids'
import { Manifest } from './manifest'

export const BackupRequest = z.object({
  scanId: z.string(),
  selectedArtifactIds: z.array(ArtifactId),
  /** Absolute path of the .devbackup to write. */
  outputPath: z.string(),
  password: z.string().min(8).max(1024),
  label: z.string().min(1).max(200),
})
export type BackupRequest = z.infer<typeof BackupRequest>

export const BackupResult = z.object({
  outputPath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  manifest: Manifest,
  verified: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
})
export type BackupResult = z.infer<typeof BackupResult>

/** Result of inspecting a .devbackup (after successful decryption of the header + manifest). */
export const BackupInspection = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  formatVersion: z.number().int().positive(),
  manifest: Manifest,
})
export type BackupInspection = z.infer<typeof BackupInspection>

/** Unencrypted header information readable without a password. */
export const BackupHeaderInfo = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  formatVersion: z.number().int().positive(),
  supported: z.boolean(),
  kdf: z.object({
    algorithm: z.string(),
    memoryKiB: z.number().int(),
    iterations: z.number().int(),
    parallelism: z.number().int(),
  }),
  cipher: z.string(),
  createdAt: z.string().optional(),
})
export type BackupHeaderInfo = z.infer<typeof BackupHeaderInfo>
