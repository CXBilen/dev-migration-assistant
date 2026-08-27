import { z } from 'zod'
import { StatusLevel } from './artifacts'
import { ArtifactId, ProjectId, ProviderId } from './ids'

export const PathMapping = z.object({
  projectId: ProjectId,
  oldPath: z.string(),
  newPath: z.string(),
})
export type PathMapping = z.infer<typeof PathMapping>

export const CollisionPolicy = z.enum(['skip', 'merge', 'backup-then-replace', 'alternate-path'])
export type CollisionPolicy = z.infer<typeof CollisionPolicy>

export const RestoreOptions = z.object({
  /** Default policy applied to collisions the user did not decide individually. */
  defaultCollisionPolicy: CollisionPolicy.default('skip'),
  includeGlobal: z.boolean().default(false),
})
export type RestoreOptions = z.infer<typeof RestoreOptions>

export const RestorePlanRequest = z.object({
  backupPath: z.string(),
  password: z.string().min(1).max(1024),
  mappings: z.array(PathMapping),
  selectedArtifactIds: z.array(ArtifactId),
  options: RestoreOptions.default({ defaultCollisionPolicy: 'skip', includeGlobal: false }),
})
export type RestorePlanRequest = z.infer<typeof RestorePlanRequest>

export const CollisionKind = z.enum([
  'directory-exists',
  'file-exists',
  'git-repo-exists',
  'claude-project-exists',
  'worktree-path-exists',
  'json-entry-exists',
])
export type CollisionKind = z.infer<typeof CollisionKind>

export const Collision = z.object({
  id: z.string(),
  providerId: ProviderId,
  projectId: ProjectId.optional(),
  kind: CollisionKind,
  path: z.string(),
  detail: z.string(),
  /** Policies this provider can honour for this collision. */
  allowedPolicies: z.array(CollisionPolicy),
  /** Policy chosen (defaults to the first allowed one, which must be non-destructive). */
  policy: CollisionPolicy,
})
export type Collision = z.infer<typeof Collision>

export const PreflightCheck = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  detail: z.string().optional(),
  blocking: z.boolean(),
  providerId: ProviderId.optional(),
  projectId: ProjectId.optional(),
})
export type PreflightCheck = z.infer<typeof PreflightCheck>

export const RestoreStep = z.object({
  id: z.string(),
  providerId: ProviderId,
  projectId: ProjectId.optional(),
  label: z.string(),
  detail: z.string().optional(),
  destination: z.string().optional(),
  /** Steps are only executed for artifacts the user selected. */
  artifactIds: z.array(ArtifactId).default([]),
})
export type RestoreStep = z.infer<typeof RestoreStep>

export const RemapAffected = z.object({
  providerId: ProviderId,
  label: z.string(),
  count: z.number().int().nonnegative(),
})
export type RemapAffected = z.infer<typeof RemapAffected>
export const UnsupportedReference = z.object({
  providerId: ProviderId,
  location: z.string(),
  reason: z.string(),
})
export type UnsupportedReference = z.infer<typeof UnsupportedReference>
export const PathRemapReport = z.object({
  mappings: z.array(PathMapping),
  affected: z.array(RemapAffected),
  safeRewriteCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
  unsupportedReferences: z.array(UnsupportedReference).default([]),
})
export type PathRemapReport = z.infer<typeof PathRemapReport>

export const RestoreProjectPlan = z.object({
  projectId: ProjectId,
  name: z.string(),
  oldPath: z.string(),
  newPath: z.string(),
  pathChanged: z.boolean(),
  steps: z.array(RestoreStep),
  collisions: z.array(Collision).default([]),
  warnings: z.array(z.string()).default([]),
})
export type RestoreProjectPlan = z.infer<typeof RestoreProjectPlan>

export const RestorePlan = z.object({
  id: z.string(),
  backupPath: z.string(),
  createdAt: z.string(),
  projects: z.array(RestoreProjectPlan),
  globalSteps: z.array(RestoreStep).default([]),
  globalCollisions: z.array(Collision).default([]),
  preflight: z.array(PreflightCheck),
  remap: PathRemapReport,
  warnings: z.array(z.string()).default([]),
  /** False when a blocking preflight check failed or an unresolved collision exists. */
  canProceed: z.boolean(),
})
export type RestorePlan = z.infer<typeof RestorePlan>

export const RestoreExecuteRequest = z.object({
  planId: z.string(),
  /** Collision decisions keyed by collision id (overrides plan defaults). */
  collisionDecisions: z.record(z.string(), CollisionPolicy).default({}),
})
export type RestoreExecuteRequest = z.infer<typeof RestoreExecuteRequest>

export const ResultItem = z.object({
  label: z.string(),
  status: StatusLevel,
  detail: z.string().optional(),
})
export type ResultItem = z.infer<typeof ResultItem>

export const ProviderRestoreOutcome = z.object({
  providerId: ProviderId,
  projectId: ProjectId.optional(),
  status: z.enum(['ok', 'partial', 'failed', 'skipped']),
  items: z.array(ResultItem).default([]),
  warnings: z.array(z.string()).default([]),
})
export type ProviderRestoreOutcome = z.infer<typeof ProviderRestoreOutcome>

export const VerificationCheck = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  detail: z.string().optional(),
  providerId: ProviderId.optional(),
  projectId: ProjectId.optional(),
})
export type VerificationCheck = z.infer<typeof VerificationCheck>
export const VerificationReport = z.object({ ok: z.boolean(), checks: z.array(VerificationCheck) })
export type VerificationReport = z.infer<typeof VerificationReport>

/** Items needing the user's attention after restore (re-auth, missing tools). */
export const AttentionItem = z.object({
  id: z.string(),
  providerId: ProviderId.optional(),
  level: z.enum(['info', 'warn']),
  title: z.string(),
  detail: z.string().optional(),
  action: z.enum(['reauth', 'install', 'manual', 'none']).default('none'),
})
export type AttentionItem = z.infer<typeof AttentionItem>

export const RestoreProjectResult = z.object({
  projectId: ProjectId,
  name: z.string(),
  newPath: z.string(),
  providers: z.array(ProviderRestoreOutcome),
})
export type RestoreProjectResult = z.infer<typeof RestoreProjectResult>

export const RestoreResult = z.object({
  planId: z.string(),
  projects: z.array(RestoreProjectResult),
  global: z.array(ProviderRestoreOutcome).default([]),
  verification: VerificationReport,
  attention: z.array(AttentionItem).default([]),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
})
export type RestoreResult = z.infer<typeof RestoreResult>
