import { z } from 'zod'
import { SerializedError } from './errors'
import { IsoDate, JobId, ProjectId, ProviderId } from './ids'

export const JobKind = z.enum(['scan', 'backup', 'inspect', 'restore-plan', 'restore', 'verify'])
export type JobKind = z.infer<typeof JobKind>

export const JobStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
export type JobStatus = z.infer<typeof JobStatus>

export const BackupPhase = z.enum([
  'IDLE',
  'DISCOVERING',
  'SCANNING',
  'PLANNING',
  'SECURITY_REVIEW',
  'COLLECTING',
  'PACKING',
  'ENCRYPTING',
  'VERIFYING',
  'COMPLETE',
  'FAILED',
  'CANCELLED',
])
export type BackupPhase = z.infer<typeof BackupPhase>

export const RestorePhase = z.enum([
  'INSPECT',
  'DECRYPT',
  'VALIDATE',
  'MAP_PATHS',
  'PREFLIGHT',
  'STAGE',
  'RESTORE_REPOSITORIES',
  'RESTORE_WORKTREE_STATE',
  'RESTORE_CLAUDE',
  'RESTORE_PROJECT_FILES',
  'VERIFY',
  'REPORT',
  'COMPLETE',
  'FAILED',
  'CANCELLED',
])
export type RestorePhase = z.infer<typeof RestorePhase>

/** Structured progress event streamed to the UI. progress is 0..1 when known; omit it rather than faking it. */
export const ProgressEvent = z.object({
  jobId: JobId,
  phase: z.string(),
  progress: z.number().min(0).max(1).optional(),
  projectId: ProjectId.optional(),
  providerId: ProviderId.optional(),
  message: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  at: IsoDate,
  /** Optional per-item completion marker for checklists ("✓ Git bundle"). */
  item: z
    .object({
      id: z.string(),
      label: z.string(),
      status: z.enum(['pending', 'running', 'done', 'warn', 'failed', 'skipped']),
    })
    .optional(),
})
export type ProgressEvent = z.infer<typeof ProgressEvent>

export const JobSnapshot = z.object({
  id: JobId,
  kind: JobKind,
  status: JobStatus,
  phase: z.string(),
  progress: z.number().min(0).max(1).optional(),
  message: z.string(),
  startedAt: IsoDate,
  finishedAt: IsoDate.optional(),
  error: SerializedError.optional(),
  /** Job-kind specific result, validated by the IPC layer with the matching schema. */
  result: z.unknown().optional(),
  recentEvents: z.array(ProgressEvent).default([]),
})
export type JobSnapshot = z.infer<typeof JobSnapshot>
