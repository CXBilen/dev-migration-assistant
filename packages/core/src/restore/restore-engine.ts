/**
 * DefaultRestoreEngine (ADR-0005, ADR-0008).
 *
 * plan():    INSPECT -> DECRYPT -> VALIDATE -> MAP_PATHS -> PREFLIGHT   (no destination writes)
 * execute(): STAGE -> RESTORE_REPOSITORIES -> RESTORE_PROJECT_FILES -> RESTORE_CLAUDE -> ... -> VERIFY -> REPORT
 *
 * Providers write only through a ScopedFs whose roots are exactly the approved destinations of the unit
 * being restored (project newPath, its derived worktree paths, the Claude config dir and ~/.claude.json).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExtractionLimits } from '@devmig/archive'
import {
  DEVBACKUP_FORMAT_VERSION,
  Collision as CollisionSchema,
  Manifest as ManifestSchema,
  PreflightCheck as PreflightCheckSchema,
  RestoreExecuteRequest as RestoreExecuteRequestSchema,
  RestorePlanRequest as RestorePlanRequestSchema,
  RestoreStep as RestoreStepSchema,
  ResultItem as ResultItemSchema,
  AttentionItem as AttentionItemSchema,
  VerificationCheck as VerificationCheckSchema,
  type AttentionItem,
  type BackupHeaderInfo,
  type BackupInspection,
  type Collision,
  type CollisionPolicy,
  type Manifest,
  type ManifestArtifact,
  type ManifestProject,
  type ManifestProviderSection,
  type PathMapping,
  type PathRemapReport,
  type PreflightCheck,
  type ProviderRestoreOutcome,
  type RestoreExecuteRequest,
  type RestorePlan,
  type RestorePlanRequest,
  type RestoreProjectPlan,
  type RestoreProjectResult,
  type RestoreResult,
  type RestoreStep,
  type VerificationCheck,
} from '@devmig/model'
import {
  MigrationError,
  ScopedFs,
  canonicalizePath,
  expandHome,
  formatBytes,
  newId,
  pathExists,
  throwIfAborted,
} from '@devmig/shared'
import { z } from 'zod'
import type { RestoreEngine } from '../api'
import type { ArchiveAdapter } from '../archive-adapter'
import { clamp01, detachedJobContext, errorMessage, makeBaseContext } from '../context'
import type { Environment } from '../environment'
import { assertPayloadIntegrity } from '../integrity/integrity-verifier'
import type { JobRunContext } from '../jobs/job-manager'
import {
  buildRemapReport,
  createPathMapper,
  deriveWorktreeMappings,
  type PathMapper,
  type ProviderRemapSection,
} from '../migration/path-remapper'
import type {
  MigrationProvider,
  ProviderRestoreInput,
  ProviderRestorePlan,
  ProviderRestoreResult,
  RemapContext,
  RestoreContext,
  RestorePlanningContext,
  VerifyContext,
} from '../providers/contract'
import type { ProviderRegistry } from '../providers/registry'
import { approveAsideRoots, collectAsidePaths } from './aside-paths'
import {
  normalizeCollisions,
  resolveCollisionDecisions,
  unitKeyFor,
  type NormalizedCollision,
} from './collisions'
import { orderProvidersForRestore, restorePhaseForProvider } from './provider-order'
import { StagingCache, freeSpaceBytes, rmQuiet, type StagingEntry } from './staging-cache'

export interface DefaultRestoreEngineOptions {
  env: Environment
  registry: ProviderRegistry
  archive: ArchiveAdapter
  /** Base directory for staging; created (0700) on demand. */
  workDir: string
  extractionLimits?: Partial<ExtractionLimits>
  /** Free space required at each destination as a multiple of payloadBytes (default 1.2). */
  freeSpaceFactor?: number
}

/** projectId used for the implicit `<old home> -> <new home>` mapping (lowest priority, ADR-0005). */
export const HOME_MAPPING_PROJECT_ID = 'home'

const RemapSectionSchema = z.object({
  affected: z
    .array(z.object({ label: z.string(), count: z.number().int().nonnegative() }))
    .default([]),
  safeRewriteCount: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string()).default([]),
  unsupportedReferences: z
    .array(z.object({ location: z.string(), reason: z.string() }))
    .default([]),
})

const ProviderRestorePlanSchema = z.object({
  providerId: z.string().optional(),
  projectId: z.string().optional(),
  steps: z.array(RestoreStepSchema).default([]),
  collisions: z.array(CollisionSchema).default([]),
  preflight: z.array(PreflightCheckSchema).default([]),
  remap: RemapSectionSchema.default({
    affected: [],
    safeRewriteCount: 0,
    warnings: [],
    unsupportedReferences: [],
  }),
  warnings: z.array(z.string()).default([]),
  state: z.record(z.string(), z.unknown()).default({}),
})

const ProviderRestoreResultSchema = z.object({
  status: z.enum(['ok', 'partial', 'failed', 'skipped']),
  items: z.array(ResultItemSchema).default([]),
  warnings: z.array(z.string()).default([]),
  attention: z.array(AttentionItemSchema).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
})

const ProviderVerificationSchema = z.object({
  checks: z.array(VerificationCheckSchema).default([]),
})

interface ProjectTarget {
  project: ManifestProject
  oldPath: string
  newPath: string
  pathChanged: boolean
  /** New absolute paths of linked worktrees outside the project directory. */
  worktreeNewPaths: string[]
}

interface PlanUnit {
  key: string
  provider: MigrationProvider
  projectId: string | undefined
  target: ProjectTarget | undefined
  input: ProviderRestoreInput
  plan: ProviderRestorePlan
  collisions: NormalizedCollision[]
  roots: string[]
  label: string
}

interface StoredPlan {
  plan: RestorePlan
  stagingKey: string
  payloadRoot: string
  manifest: Manifest
  mappings: PathMapping[]
  mapper: PathMapper
  units: PlanUnit[]
  targets: ProjectTarget[]
  status: 'planned' | 'executing' | 'executed' | 'failed'
}

interface ExecutedUnit {
  unit: PlanUnit
  outcome: ProviderRestoreOutcome
  result: ProviderRestoreResult | undefined
  error: string | undefined
}

interface SelectedSection {
  project: ManifestProject | undefined
  section: ManifestProviderSection
  artifacts: ManifestArtifact[]
}

function isCredential(a: ManifestArtifact): boolean {
  return a.sensitivity === 'credential'
}

export class DefaultRestoreEngine implements RestoreEngine {
  private readonly env: Environment
  private readonly registry: ProviderRegistry
  private readonly archive: ArchiveAdapter
  private readonly workDir: string
  private readonly staging: StagingCache
  private readonly plans = new Map<string, StoredPlan>()
  private readonly freeSpaceFactor: number

  constructor(options: DefaultRestoreEngineOptions) {
    this.env = options.env
    this.registry = options.registry
    this.archive = options.archive
    this.workDir = options.workDir
    this.freeSpaceFactor = options.freeSpaceFactor ?? 1.2
    this.staging = new StagingCache({
      archive: options.archive,
      workDir: options.workDir,
      logger: options.env.logger,
      freeSpaceFactor: this.freeSpaceFactor,
      ...(options.extractionLimits ? { extractionLimits: options.extractionLimits } : {}),
    })
  }

  // ---------------------------------------------------------------- read-only entry points

  async readHeader(backupPath: string): Promise<BackupHeaderInfo> {
    const resolved = await this.resolveBackupPath(backupPath)
    const result = await this.archive.readDevBackupHeader(resolved)
    const { header } = result
    return {
      path: resolved,
      sizeBytes: result.sizeBytes,
      formatVersion: header.formatVersion,
      supported: result.supported,
      kdf: {
        algorithm: header.kdf.algorithm,
        memoryKiB: header.kdf.memoryKiB,
        iterations: header.kdf.iterations,
        parallelism: header.kdf.parallelism,
      },
      cipher: header.cipher,
      createdAt: header.createdAt,
    }
  }

  async inspect(
    backupPath: string,
    password: string,
    ctx?: JobRunContext,
  ): Promise<BackupInspection> {
    const job = ctx ?? detachedJobContext(this.env)
    const resolved = await this.resolveBackupPath(backupPath)
    job.setPhase('INSPECT', 'Reading backup…')
    const result = await this.archive.inspectDevBackup({
      path: resolved,
      password,
      signal: job.signal,
    })
    const manifest = this.parseManifest(result.manifest)
    return {
      path: resolved,
      sizeBytes: result.sizeBytes,
      formatVersion: result.header.formatVersion,
      manifest,
    }
  }

  async verify(
    backupPath: string,
    password: string,
    ctx: JobRunContext,
  ): Promise<{ ok: boolean; entries: number; bytes: number }> {
    const resolved = await this.resolveBackupPath(backupPath)
    ctx.setPhase('VERIFY', 'Verifying backup…')
    const result = await this.archive.verifyDevBackup({
      path: resolved,
      password,
      signal: ctx.signal,
      onProgress: (p) => {
        ctx.progress(p.message ?? `Verified ${p.entries} entries`, {
          ...(p.totalBytes ? { progress: clamp01(p.bytes / p.totalBytes) } : {}),
        })
      },
    })
    ctx.progress(`Verified ${result.entries} entries (${formatBytes(result.bytes)})`, {
      progress: 1,
    })
    return { ok: result.ok, entries: result.entries, bytes: result.bytes }
  }

  async previewRemap(
    backupPath: string,
    password: string,
    mappings: PathMapping[],
    ctx?: JobRunContext,
  ): Promise<PathRemapReport> {
    const job = ctx ?? detachedJobContext(this.env)
    const resolved = await this.resolveBackupPath(backupPath)
    job.setPhase('DECRYPT', 'Preparing backup for analysis…')
    const staging = await this.staging.acquire(resolved, password, job)
    const manifest = await this.loadManifest(staging)
    job.setPhase('MAP_PATHS', 'Analysing path references…')
    const warnings: string[] = []
    const projectIds = new Set(manifest.projects.map((p) => p.id))
    const { targets, mappings: fullMappings } = this.buildMappings(
      manifest,
      mappings,
      projectIds,
      warnings,
    )
    const mapper = createPathMapper(fullMappings, { homeDir: this.env.homeDir })
    const sections: ProviderRemapSection[] = []

    const analyse = async (
      project: ManifestProject | undefined,
      section: ManifestProviderSection,
    ): Promise<void> => {
      throwIfAborted(job.signal)
      if (!this.registry.has(section.providerId)) {
        warnings.push(
          `Provider "${section.providerId}" is not available in this build; its path references were not analysed.`,
        )
        return
      }
      const provider = this.registry.get(section.providerId)
      const target = project ? targets.get(project.id) : undefined
      const input: ProviderRestoreInput = {
        ...(project && target
          ? {
              project: {
                id: project.id,
                name: project.name,
                oldPath: target.oldPath,
                newPath: target.newPath,
              },
            }
          : {}),
        section,
        artifacts: section.artifacts.filter((a) => !isCredential(a)),
      }
      const attribution = { providerId: provider.id, ...(project ? { projectId: project.id } : {}) }
      try {
        if (provider.remapPaths) {
          const remapCtx: RemapContext = {
            ...makeBaseContext(this.env, job, attribution),
            payloadRoot: staging.payloadRoot,
          }
          const result = await provider.remapPaths(fullMappings, input, remapCtx)
          sections.push({
            providerId: provider.id,
            remap: {
              affected: result.report.affected.map((a) => ({ label: a.label, count: a.count })),
              safeRewriteCount: result.report.safeRewriteCount,
              warnings: result.report.warnings,
              unsupportedReferences: result.report.unsupportedReferences.map((u) => ({
                location: u.location,
                reason: u.reason,
              })),
            },
          })
        } else {
          const planningCtx: RestorePlanningContext = {
            ...makeBaseContext(this.env, job, attribution),
            payloadRoot: staging.payloadRoot,
            mappings: fullMappings,
            mapPath: mapper.mapPath,
            defaultCollisionPolicy: 'skip',
            restoreHints: manifest.restoreHints,
          }
          const plan = await provider.planRestore(input, planningCtx)
          const parsed = ProviderRestorePlanSchema.parse(plan)
          sections.push({ providerId: provider.id, remap: parsed.remap })
        }
      } catch (err) {
        if (job.signal.aborted) throw err
        job.logger.warn('Remap analysis failed', { ...attribution, error: errorMessage(err) })
        warnings.push(
          `${provider.displayName}${project ? ` (${project.name})` : ''}: path analysis failed: ${errorMessage(err)}`,
        )
      }
    }

    for (const project of manifest.projects) {
      for (const section of project.providers) await analyse(project, section)
    }
    for (const section of manifest.global) await analyse(undefined, section)

    const report = buildRemapReport(sections, fullMappings)
    report.warnings.push(...warnings)
    return report
  }

  // ---------------------------------------------------------------- plan

  async plan(rawRequest: RestorePlanRequest, ctx: JobRunContext): Promise<RestorePlan> {
    const parsed = RestorePlanRequestSchema.safeParse(rawRequest)
    if (!parsed.success) {
      throw new MigrationError('INVALID_INPUT', 'Invalid restore request.', {
        details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      })
    }
    const request = parsed.data
    const planId = newId('plan')
    const warnings: string[] = []

    // ---- INSPECT ----
    ctx.setPhase('INSPECT', 'Reading backup header…')
    const backupPath = await this.resolveBackupPath(request.backupPath)
    const headerInfo = await this.archive.readDevBackupHeader(backupPath)
    if (!headerInfo.supported) {
      throw new MigrationError(
        'ARCHIVE_UNSUPPORTED_VERSION',
        `This backup uses container format version ${headerInfo.header.formatVersion}, which this app cannot read.`,
        { hint: 'Update Dev Migration Assistant and try again.' },
      )
    }

    // ---- DECRYPT ----
    ctx.setPhase('DECRYPT', 'Decrypting and extracting the backup into private staging…')
    const staging = await this.staging.acquire(backupPath, request.password, ctx)
    this.staging.retain(staging.key, planId)
    try {
      // ---- VALIDATE ----
      ctx.setPhase('VALIDATE', 'Validating manifest and payload…')
      const manifest = await this.loadManifest(staging)
      if (!staging.checksumsVerified) {
        ctx.progress('Verifying payload checksums…')
        await assertPayloadIntegrity(staging.payloadRoot, { signal: ctx.signal })
        staging.checksumsVerified = true
      }
      const selected = this.selectArtifacts(manifest, request, warnings)
      const skippedProviders = new Set<string>()
      const plannedSections: SelectedSection[] = []
      for (const s of selected) {
        if (!this.registry.has(s.section.providerId)) {
          skippedProviders.add(s.section.providerId)
          continue
        }
        const provider = this.registry.get(s.section.providerId)
        if (s.section.schemaVersion > provider.schemaVersion) {
          warnings.push(
            `${provider.displayName}: the backup was written with a newer payload layout (v${s.section.schemaVersion}) than this build understands (v${provider.schemaVersion}); restore may be incomplete.`,
          )
        }
        plannedSections.push(s)
      }
      for (const id of skippedProviders) {
        const count = selected
          .filter((s) => s.section.providerId === id)
          .reduce((n, s) => n + s.artifacts.length, 0)
        warnings.push(
          `Provider "${id}" is not available in this build; ${count} selected item(s) were skipped.`,
        )
      }
      if (plannedSections.length === 0) {
        throw new MigrationError(
          'INVALID_INPUT',
          'None of the selected items can be restored by this build.',
          { details: { skippedProviders: [...skippedProviders] } },
        )
      }

      // ---- MAP_PATHS ----
      ctx.setPhase('MAP_PATHS', 'Resolving destination paths…')
      const projectIds = new Set(plannedSections.flatMap((s) => (s.project ? [s.project.id] : [])))
      const { targets, mappings } = this.buildMappings(
        manifest,
        request.mappings,
        projectIds,
        warnings,
      )
      const mapper = createPathMapper(mappings, { homeDir: this.env.homeDir })

      // ---- PREFLIGHT ----
      ctx.setPhase('PREFLIGHT', 'Running preflight checks…')
      const preflight: PreflightCheck[] = await this.enginePreflight(
        [...targets.values()],
        manifest,
        plannedSections.some((s) => !s.project),
      )
      const units: PlanUnit[] = []
      const seenCollisionIds = new Set<string>()
      const seenStepIds = new Set<string>()
      const totalUnits = plannedSections.length
      let done = 0
      for (const section of plannedSections) {
        throwIfAborted(ctx.signal)
        const provider = this.registry.get(section.section.providerId)
        const target = section.project ? targets.get(section.project.id) : undefined
        const projectId = section.project?.id
        const key = unitKeyFor(provider.id, projectId)
        const label = section.project
          ? `${provider.displayName} · ${section.project.name}`
          : `${provider.displayName} (user-wide)`
        const attribution = { providerId: provider.id, ...(projectId ? { projectId } : {}) }
        ctx.progress(`Planning ${label}…`, {
          ...attribution,
          progress: totalUnits > 0 ? done / totalUnits : undefined,
          item: { id: key, label, status: 'running' },
        })
        const input: ProviderRestoreInput = {
          ...(section.project && target
            ? {
                project: {
                  id: section.project.id,
                  name: section.project.name,
                  oldPath: target.oldPath,
                  newPath: target.newPath,
                },
              }
            : {}),
          section: section.section,
          artifacts: section.artifacts,
        }
        const planningCtx: RestorePlanningContext = {
          ...makeBaseContext(this.env, ctx, attribution),
          payloadRoot: staging.payloadRoot,
          mappings,
          mapPath: mapper.mapPath,
          defaultCollisionPolicy: request.options.defaultCollisionPolicy,
          restoreHints: manifest.restoreHints,
        }
        let providerPlan: ProviderRestorePlan
        try {
          const raw = await provider.planRestore(input, planningCtx)
          const parsedPlan = ProviderRestorePlanSchema.safeParse(raw)
          if (!parsedPlan.success) {
            throw new MigrationError(
              'PROVIDER_FAILED',
              `${provider.displayName} returned an invalid restore plan: ${parsedPlan.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')}`,
              { details: attribution },
            )
          }
          providerPlan = {
            providerId: provider.id,
            ...(projectId ? { projectId } : {}),
            steps: parsedPlan.data.steps,
            collisions: parsedPlan.data.collisions,
            preflight: parsedPlan.data.preflight,
            remap: parsedPlan.data.remap,
            warnings: parsedPlan.data.warnings,
            state: parsedPlan.data.state,
          }
        } catch (err) {
          if (ctx.signal.aborted) throw err
          const message = errorMessage(err)
          ctx.logger.error('Provider planning failed', { ...attribution, error: message })
          preflight.push({
            id: `${key}:planning`,
            label: `${label}: planning failed`,
            status: 'fail',
            detail: message,
            blocking: true,
            providerId: provider.id,
            ...(projectId ? { projectId } : {}),
          })
          warnings.push(`${label}: planning failed: ${message}`)
          ctx.progress(`${label}: planning failed`, {
            ...attribution,
            level: 'error',
            item: { id: key, label, status: 'failed' },
          })
          done += 1
          continue
        }
        const collisions = normalizeCollisions(
          provider.id,
          projectId,
          providerPlan.collisions,
          request.options.defaultCollisionPolicy,
          seenCollisionIds,
        )
        providerPlan.steps = providerPlan.steps.map((step) =>
          normalizeStep(step, provider.id, projectId, key, seenStepIds),
        )
        for (const check of providerPlan.preflight) {
          preflight.push({
            ...check,
            id: check.id.startsWith(`${provider.id}:`) ? check.id : `${key}:${check.id}`,
            providerId: provider.id,
            ...(projectId ? { projectId } : {}),
          })
        }
        const roots = target
          ? [
              target.newPath,
              ...target.worktreeNewPaths,
              this.env.claudeConfigDir,
              this.env.claudeJsonPath,
            ]
          : [this.env.claudeConfigDir, this.env.claudeJsonPath]
        units.push({
          key,
          provider,
          projectId,
          target,
          input,
          plan: providerPlan,
          collisions,
          roots,
          label,
        })
        done += 1
        const hasWarnings = providerPlan.warnings.length > 0
        ctx.progress(`${hasWarnings ? '!' : '✓'} ${label}`, {
          ...attribution,
          progress: totalUnits > 0 ? done / totalUnits : undefined,
          item: { id: key, label, status: hasWarnings ? 'warn' : 'done' },
        })
      }

      // ---- assemble ----
      const projects: RestoreProjectPlan[] = []
      for (const project of manifest.projects) {
        const target = targets.get(project.id)
        if (!target) continue
        const projectUnits = units.filter((u) => u.projectId === project.id)
        if (projectUnits.length === 0 && !preflight.some((c) => c.projectId === project.id))
          continue
        projects.push({
          projectId: project.id,
          name: project.name,
          oldPath: target.oldPath,
          newPath: target.newPath,
          pathChanged: target.pathChanged,
          steps: projectUnits.flatMap((u) => u.plan.steps),
          collisions: projectUnits.flatMap((u) => u.collisions.map((c) => c.collision)),
          warnings: projectUnits.flatMap((u) =>
            u.plan.warnings.map((w) => `${u.provider.displayName}: ${w}`),
          ),
        })
      }
      const globalUnits = units.filter((u) => u.projectId === undefined)
      const remap = buildRemapReport(
        units.map((u) => ({ providerId: u.provider.id, remap: u.plan.remap })),
        mappings,
      )
      for (const u of globalUnits) {
        warnings.push(...u.plan.warnings.map((w) => `${u.provider.displayName}: ${w}`))
      }
      const canProceed =
        units.length > 0 && !preflight.some((c) => c.status === 'fail' && c.blocking)
      const plan: RestorePlan = {
        id: planId,
        backupPath,
        createdAt: new Date().toISOString(),
        projects,
        globalSteps: globalUnits.flatMap((u) => u.plan.steps),
        globalCollisions: globalUnits.flatMap((u) => u.collisions.map((c) => c.collision)),
        preflight,
        remap,
        warnings,
        canProceed,
      }
      this.plans.set(planId, {
        plan,
        stagingKey: staging.key,
        payloadRoot: staging.payloadRoot,
        manifest,
        mappings,
        mapper,
        units,
        targets: [...targets.values()],
        status: 'planned',
      })
      ctx.progress(
        canProceed
          ? `Restore plan ready: ${projects.length} project(s), ${plan.projects.reduce((n, p) => n + p.collisions.length, 0) + plan.globalCollisions.length} collision(s)`
          : 'Restore plan has blocking issues',
        { progress: 1, level: canProceed ? 'info' : 'warn' },
      )
      return plan
    } catch (err) {
      this.staging.release(staging.key, planId)
      throw err
    }
  }

  // ---------------------------------------------------------------- execute

  async execute(rawRequest: RestoreExecuteRequest, ctx: JobRunContext): Promise<RestoreResult> {
    const startedAt = Date.now()
    const parsed = RestoreExecuteRequestSchema.safeParse(rawRequest)
    if (!parsed.success) {
      throw new MigrationError('INVALID_INPUT', 'Invalid restore execution request.', {
        details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      })
    }
    const request = parsed.data
    const stored = this.plans.get(request.planId)
    if (!stored) {
      throw new MigrationError(
        'RESTORE_PLAN_REJECTED',
        `Unknown or expired restore plan: ${request.planId}`,
        {
          hint: 'Create a new restore plan and try again.',
          details: { planId: request.planId },
        },
      )
    }
    if (stored.status !== 'planned') {
      throw new MigrationError(
        'RESTORE_PLAN_REJECTED',
        `This restore plan was already ${stored.status === 'executing' ? 'started' : 'executed'}.`,
        {
          hint: 'Create a new restore plan to run the restore again.',
          details: { planId: request.planId },
        },
      )
    }
    if (!stored.plan.canProceed) {
      throw new MigrationError(
        'RESTORE_PLAN_REJECTED',
        'The restore plan has blocking preflight failures and cannot be executed.',
        {
          details: {
            failures: stored.plan.preflight
              .filter((c) => c.status === 'fail' && c.blocking)
              .map((c) => c.label),
          },
        },
      )
    }
    if (!(await pathExists(stored.payloadRoot))) {
      stored.status = 'failed'
      throw new MigrationError(
        'RESTORE_PLAN_REJECTED',
        'The staged backup payload for this plan is no longer available.',
        { hint: 'Create a new restore plan.', details: { planId: request.planId } },
      )
    }
    const decisions = resolveCollisionDecisions(
      stored.units.flatMap((u) => u.collisions),
      request.collisionDecisions,
    )
    stored.status = 'executing'
    const warnings: string[] = []
    const attention: AttentionItem[] = []
    const executed: ExecutedUnit[] = []

    ctx.setPhase('STAGE', 'Preparing restore…')
    await fs.mkdir(this.workDir, { recursive: true, mode: 0o700 })
    const tempRoot = await fs.mkdtemp(path.join(this.workDir, 'restore-tmp-'))
    await fs.chmod(tempRoot, 0o700)
    try {
      const order = orderProvidersForRestore(this.registry.ids())
      const unitsByProvider = new Map<string, PlanUnit[]>()
      for (const unit of stored.units) {
        const list = unitsByProvider.get(unit.provider.id) ?? []
        list.push(unit)
        unitsByProvider.set(unit.provider.id, list)
      }
      const total = stored.units.length
      let done = 0
      for (const providerId of order) {
        const units = unitsByProvider.get(providerId)
        if (!units || units.length === 0) continue
        const provider = this.registry.get(providerId)
        ctx.setPhase(restorePhaseForProvider(providerId), `Restoring ${provider.displayName}…`)
        // Projects first (manifest order), then the user-wide section.
        const ordered = [...units.filter((u) => u.target), ...units.filter((u) => !u.target)]
        for (const unit of ordered) {
          throwIfAborted(ctx.signal)
          const attribution = {
            providerId: unit.provider.id,
            ...(unit.projectId ? { projectId: unit.projectId } : {}),
          }
          ctx.progress(`Restoring ${unit.label}…`, {
            ...attribution,
            progress: total > 0 ? done / total : undefined,
            item: { id: unit.key, label: unit.label, status: 'running' },
          })
          const tempDir = await fs.mkdtemp(path.join(tempRoot, `${unit.provider.id}-`))
          const unitDecisions = decisions.get(unit.key) ?? {}
          const aside = approveAsideRoots(
            unit.roots,
            collectAsidePaths(unit.plan.state),
            unitDecisions,
          )
          if (aside.rejected.length > 0) {
            ctx.logger.warn('Ignoring aside paths outside the approved destinations', {
              ...attribution,
              rejected: aside.rejected,
            })
          }
          const restoreCtx: RestoreContext = {
            ...makeBaseContext(this.env, ctx, attribution),
            payloadRoot: stored.payloadRoot,
            mappings: stored.mappings,
            mapPath: stored.mapper.mapPath,
            fs: new ScopedFs([...unit.roots, ...aside.approved]),
            collisionDecisions: unitDecisions,
            tempDir,
          }
          let result: ProviderRestoreResult | undefined
          let error: string | undefined
          try {
            const raw = await unit.provider.restore(unit.plan, unit.input, restoreCtx)
            const parsedResult = ProviderRestoreResultSchema.safeParse(raw)
            if (!parsedResult.success) {
              throw new MigrationError(
                'PROVIDER_FAILED',
                `${unit.provider.displayName} returned an invalid restore result: ${parsedResult.error.issues
                  .map((i) => `${i.path.join('.')}: ${i.message}`)
                  .join('; ')}`,
                { details: attribution },
              )
            }
            result = {
              providerId: unit.provider.id,
              ...(unit.projectId ? { projectId: unit.projectId } : {}),
              status: parsedResult.data.status,
              items: parsedResult.data.items,
              warnings: parsedResult.data.warnings,
              ...(parsedResult.data.attention ? { attention: parsedResult.data.attention } : {}),
              ...(parsedResult.data.state ? { state: parsedResult.data.state } : {}),
            }
          } catch (err) {
            if (ctx.signal.aborted) throw err
            error = errorMessage(err)
            ctx.logger.error('Provider restore failed', { ...attribution, error })
          }
          const outcome: ProviderRestoreOutcome = result
            ? {
                providerId: result.providerId,
                ...(result.projectId ? { projectId: result.projectId } : {}),
                status: result.status,
                items: result.items,
                warnings: result.warnings,
              }
            : {
                providerId: unit.provider.id,
                ...(unit.projectId ? { projectId: unit.projectId } : {}),
                status: 'failed',
                items: [{ label: unit.label, status: 'error', detail: error }],
                warnings: [error ?? 'Restore failed'],
              }
          for (const w of outcome.warnings) warnings.push(`${unit.label}: ${w}`)
          for (const item of result?.attention ?? []) {
            attention.push({
              ...item,
              id: item.id.startsWith(`${unit.provider.id}:`) ? item.id : `${unit.key}:${item.id}`,
              providerId: unit.provider.id,
            })
          }
          executed.push({ unit, outcome, result, error })
          done += 1
          const itemStatus =
            outcome.status === 'failed'
              ? 'failed'
              : outcome.status === 'skipped'
                ? 'skipped'
                : outcome.status === 'partial' || outcome.warnings.length > 0
                  ? 'warn'
                  : 'done'
          ctx.progress(
            outcome.status === 'failed'
              ? `${unit.label} failed: ${error ?? 'unknown error'}`
              : `${itemStatus === 'done' ? '✓' : '!'} ${unit.label}`,
            {
              ...attribution,
              level:
                outcome.status === 'failed' ? 'error' : itemStatus === 'warn' ? 'warn' : 'info',
              progress: total > 0 ? done / total : undefined,
              item: { id: unit.key, label: unit.label, status: itemStatus },
            },
          )
        }
      }

      // ---- VERIFY ----
      ctx.setPhase('VERIFY', 'Verifying restored state…')
      const checks: VerificationCheck[] = []
      for (const entry of executed) {
        throwIfAborted(ctx.signal)
        const { unit } = entry
        const attribution = {
          providerId: unit.provider.id,
          ...(unit.projectId ? { projectId: unit.projectId } : {}),
        }
        if (!entry.result) {
          checks.push({
            id: `${unit.key}:restore`,
            label: `${unit.label}: restore failed`,
            status: 'fail',
            detail: entry.error,
            ...attribution,
          })
          continue
        }
        try {
          const verifyCtx: VerifyContext = {
            ...makeBaseContext(this.env, ctx, attribution),
            payloadRoot: stored.payloadRoot,
            mapPath: stored.mapper.mapPath,
          }
          const raw = await unit.provider.verify(
            { plan: unit.plan, result: entry.result, input: unit.input },
            verifyCtx,
          )
          const parsedVerification = ProviderVerificationSchema.parse(raw)
          for (const check of parsedVerification.checks) {
            checks.push({
              ...check,
              id: check.id.startsWith(`${unit.provider.id}:`)
                ? check.id
                : `${unit.key}:${check.id}`,
              ...attribution,
            })
          }
        } catch (err) {
          if (ctx.signal.aborted) throw err
          const message = errorMessage(err)
          ctx.logger.error('Provider verification failed', { ...attribution, error: message })
          checks.push({
            id: `${unit.key}:verify`,
            label: `${unit.label}: verification failed`,
            status: 'fail',
            detail: message,
            ...attribution,
          })
        }
      }

      // ---- REPORT ----
      ctx.setPhase('REPORT', 'Preparing report…')
      const projects: RestoreProjectResult[] = stored.targets
        .filter((t) => executed.some((e) => e.unit.projectId === t.project.id))
        .map((t) => ({
          projectId: t.project.id,
          name: t.project.name,
          newPath: t.newPath,
          providers: executed
            .filter((e) => e.unit.projectId === t.project.id)
            .map((e) => e.outcome),
        }))
      const global = executed.filter((e) => e.unit.projectId === undefined).map((e) => e.outcome)
      const verification = { ok: !checks.some((c) => c.status === 'fail'), checks }
      const result: RestoreResult = {
        planId: request.planId,
        projects,
        global,
        verification,
        attention,
        durationMs: Date.now() - startedAt,
        warnings,
      }
      stored.status = 'executed'
      const failedUnits = executed.filter((e) => e.outcome.status === 'failed').length
      ctx.progress(
        failedUnits > 0
          ? `Restore finished with ${failedUnits} failed step(s)`
          : verification.ok
            ? 'Restore complete and verified'
            : 'Restore complete; verification reported problems',
        { progress: 1, level: failedUnits > 0 || !verification.ok ? 'warn' : 'info' },
      )
      return result
    } catch (err) {
      stored.status = 'failed'
      throw err
    } finally {
      await rmQuiet(tempRoot, ctx.logger)
      this.staging.release(stored.stagingKey, request.planId)
      const stillNeeded = [...this.plans.values()].some(
        (p) => p !== stored && p.status === 'planned' && p.stagingKey === stored.stagingKey,
      )
      if (!stillNeeded) {
        ctx.logger.info('Removing staged payload after restore', { planId: request.planId })
        await this.staging.remove(stored.stagingKey)
      }
    }
  }

  getPlan(planId: string): RestorePlan | undefined {
    return this.plans.get(planId)?.plan
  }

  /** Removes staging directories that no pending plan depends on. */
  async cleanup(): Promise<void> {
    for (const [id, stored] of this.plans) {
      if (stored.status === 'executed' || stored.status === 'failed') {
        this.staging.release(stored.stagingKey, id)
      }
    }
    await this.staging.cleanup()
  }

  async dispose(): Promise<void> {
    await this.staging.dispose()
    this.plans.clear()
  }

  // ---------------------------------------------------------------- helpers

  private async resolveBackupPath(requested: string): Promise<string> {
    const trimmed = requested.trim()
    if (!trimmed) throw new MigrationError('INVALID_INPUT', 'Backup path must not be empty.')
    const expanded = expandHome(trimmed, this.env.homeDir)
    if (!path.isAbsolute(expanded)) {
      throw new MigrationError('INVALID_INPUT', `Backup path must be absolute: ${requested}`, {
        details: { path: requested },
      })
    }
    const resolved = canonicalizePath(expanded, this.env.homeDir)
    let stat
    try {
      stat = await fs.stat(resolved)
    } catch {
      throw new MigrationError('PATH_NOT_FOUND', `Backup file not found: ${resolved}`, {
        details: { path: resolved },
      })
    }
    if (!stat.isFile()) {
      throw new MigrationError('INVALID_INPUT', `Not a backup file: ${resolved}`, {
        details: { path: resolved },
      })
    }
    return resolved
  }

  private parseManifest(raw: unknown): Manifest {
    const result = ManifestSchema.safeParse(raw)
    if (!result.success) {
      throw new MigrationError('MANIFEST_INVALID', 'The backup manifest is invalid.', {
        details: {
          issues: result.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`),
        },
      })
    }
    const manifest = result.data
    if (manifest.formatVersion !== DEVBACKUP_FORMAT_VERSION) {
      throw new MigrationError(
        'ARCHIVE_UNSUPPORTED_VERSION',
        `Unsupported backup format version ${manifest.formatVersion} (expected ${DEVBACKUP_FORMAT_VERSION}).`,
        { hint: 'Update Dev Migration Assistant and try again.' },
      )
    }
    return manifest
  }

  /** Reads and validates manifest.json from the extracted payload (the file is untrusted input). */
  private async loadManifest(staging: StagingEntry): Promise<Manifest> {
    const file = path.join(staging.payloadRoot, 'manifest.json')
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (err) {
      throw new MigrationError('MANIFEST_INVALID', 'manifest.json is missing or not valid JSON.', {
        details: { file },
        cause: err,
      })
    }
    const manifest = this.parseManifest(raw)
    if (manifest.id !== staging.manifest.id) {
      throw new MigrationError(
        'INTEGRITY_MISMATCH',
        'The manifest inside the payload does not match the archive header.',
        { details: { expected: staging.manifest.id, actual: manifest.id } },
      )
    }
    return manifest
  }

  private selectArtifacts(
    manifest: Manifest,
    request: RestorePlanRequest,
    warnings: string[],
  ): SelectedSection[] {
    const index = new Map<
      string,
      {
        project: ManifestProject | undefined
        section: ManifestProviderSection
        artifact: ManifestArtifact
      }
    >()
    for (const project of manifest.projects) {
      for (const section of project.providers) {
        for (const artifact of section.artifacts)
          index.set(artifact.id, { project, section, artifact })
      }
    }
    for (const section of manifest.global) {
      for (const artifact of section.artifacts)
        index.set(artifact.id, { project: undefined, section, artifact })
    }
    const unknown: string[] = []
    const credentials: string[] = []
    const chosen = new Map<ManifestProviderSection, SelectedSection>()
    const add = (entry: {
      project: ManifestProject | undefined
      section: ManifestProviderSection
      artifact: ManifestArtifact
    }): void => {
      let selected = chosen.get(entry.section)
      if (!selected) {
        selected = { project: entry.project, section: entry.section, artifacts: [] }
        chosen.set(entry.section, selected)
      }
      if (!selected.artifacts.includes(entry.artifact)) selected.artifacts.push(entry.artifact)
    }
    let globalSelected = 0
    for (const id of new Set(request.selectedArtifactIds)) {
      const entry = index.get(id)
      if (!entry) {
        unknown.push(id)
        continue
      }
      if (isCredential(entry.artifact)) {
        credentials.push(id)
        continue
      }
      if (!entry.project) {
        if (!request.options.includeGlobal) continue
        globalSelected += 1
      }
      add(entry)
    }
    if (unknown.length > 0) {
      throw new MigrationError(
        'INVALID_INPUT',
        `Unknown artifact id(s) in the restore selection: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`,
        { details: { unknown } },
      )
    }
    if (credentials.length > 0) {
      throw new MigrationError(
        'INVALID_INPUT',
        'Credentials can never be restored. Re-authenticate on this machine instead.',
        { details: { credentials } },
      )
    }
    const ignoredGlobal = request.selectedArtifactIds.filter((id) => {
      const entry = index.get(id)
      return entry !== undefined && !entry.project && !isCredential(entry.artifact)
    })
    if (!request.options.includeGlobal && ignoredGlobal.length > 0) {
      warnings.push(
        `${ignoredGlobal.length} user-wide item(s) were selected but "include user-wide state" is off; they were skipped.`,
      )
    }
    if (request.options.includeGlobal && globalSelected === 0) {
      for (const section of manifest.global) {
        for (const artifact of section.artifacts) {
          if (!isCredential(artifact)) add({ project: undefined, section, artifact })
        }
      }
    }
    if (chosen.size === 0) {
      throw new MigrationError('INVALID_INPUT', 'Select at least one item to restore.')
    }
    // Manifest order: projects (their sections in order), then global sections.
    const ordered: SelectedSection[] = []
    for (const project of manifest.projects) {
      for (const section of project.providers) {
        const s = chosen.get(section)
        if (s) ordered.push(s)
      }
    }
    for (const section of manifest.global) {
      const s = chosen.get(section)
      if (s) ordered.push(s)
    }
    return ordered
  }

  /** Resolves destination paths for the given projects and derives worktree mappings (ADR-0005). */
  private buildMappings(
    manifest: Manifest,
    requested: PathMapping[],
    projectIds: Set<string>,
    warnings: string[],
  ): { targets: Map<string, ProjectTarget>; mappings: PathMapping[] } {
    const homeDir = this.env.homeDir
    const canonical = (p: string, what: string): string => {
      const expanded = expandHome(p.trim(), homeDir)
      if (!path.isAbsolute(expanded)) {
        throw new MigrationError('INVALID_INPUT', `${what} must be an absolute path: ${p}`, {
          details: { path: p },
        })
      }
      return canonicalizePath(expanded, homeDir)
    }
    const knownProjectIds = new Set(manifest.projects.map((p) => p.id))
    for (const m of requested) {
      if (!knownProjectIds.has(m.projectId)) {
        warnings.push(`Mapping for unknown project "${m.projectId}" was ignored.`)
      }
    }
    const targets = new Map<string, ProjectTarget>()
    const mappings: PathMapping[] = []
    const byNewPath = new Map<string, string>()
    for (const project of manifest.projects) {
      if (!projectIds.has(project.id)) continue
      const oldPath = canonical(project.canonicalPath, 'Project path')
      const explicit =
        requested.find((m) => m.projectId === project.id) ??
        requested.find((m) => canonical(m.oldPath, 'mapping.oldPath') === oldPath)
      let newPath: string
      if (explicit) {
        newPath = canonical(explicit.newPath, `Destination for "${project.name}"`)
      } else {
        newPath = oldPath
        warnings.push(
          `No destination chosen for "${project.name}"; it will be restored to its original location ${oldPath}.`,
        )
      }
      const root = path.parse(newPath).root
      if (newPath === root || newPath === canonicalizePath(homeDir)) {
        throw new MigrationError(
          'INVALID_INPUT',
          `Refusing to restore "${project.name}" directly into ${newPath}.`,
          { hint: 'Choose a project folder inside your home directory.' },
        )
      }
      const clash = byNewPath.get(newPath)
      if (clash) {
        throw new MigrationError(
          'PROJECT_PATH_COLLISION',
          `Two projects map to the same destination ${newPath} ("${clash}" and "${project.name}").`,
          { details: { newPath } },
        )
      }
      byNewPath.set(newPath, project.name)
      const mapping: PathMapping = { projectId: project.id, oldPath, newPath }
      mappings.push(mapping)
      const derived = deriveWorktreeMappings(project, mapping, { homeDir })
      mappings.push(...derived)
      targets.set(project.id, {
        project,
        oldPath,
        newPath,
        pathChanged: oldPath !== newPath,
        worktreeNewPaths: derived.map((d) => d.newPath),
      })
    }
    for (const [aId, a] of targets) {
      for (const [bId, b] of targets) {
        if (aId === bId) continue
        const rel = path.relative(a.newPath, b.newPath)
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          warnings.push(
            `"${b.project.name}" will be restored inside "${a.project.name}" (${b.newPath}).`,
          )
        }
      }
    }
    const home = implicitHomeMapping(manifest, homeDir, mappings)
    if (home) mappings.push(home)
    return { targets, mappings }
  }

  private async enginePreflight(
    targets: ProjectTarget[],
    manifest: Manifest,
    hasGlobal: boolean,
  ): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = []
    const needed = Math.ceil(manifest.stats.payloadBytes * this.freeSpaceFactor)

    // Work dir (staging + temp files) must be writable.
    try {
      await fs.access(this.workDir, fs.constants.W_OK)
      checks.push({
        id: 'engine:workdir',
        label: 'Working directory is writable',
        status: 'pass',
        blocking: true,
        detail: this.workDir,
      })
    } catch {
      checks.push({
        id: 'engine:workdir',
        label: 'Working directory is not writable',
        status: 'fail',
        blocking: true,
        detail: this.workDir,
      })
    }

    const checkedVolumes = new Set<string>()
    const destinationCheck = async (
      label: string,
      destination: string,
      projectId: string | undefined,
      idSuffix: string,
    ): Promise<void> => {
      const base = { ...(projectId ? { projectId } : {}) }
      const existing = await nearestExistingAncestor(destination)
      if (!existing) {
        checks.push({
          id: `engine:dest:${idSuffix}`,
          label: `${label}: destination volume not found`,
          status: 'fail',
          blocking: true,
          detail: destination,
          ...base,
        })
        return
      }
      let stat
      try {
        stat = await fs.stat(existing)
      } catch {
        stat = undefined
      }
      if (!stat?.isDirectory()) {
        checks.push({
          id: `engine:dest:${idSuffix}`,
          label: `${label}: destination parent is not a directory`,
          status: 'fail',
          blocking: true,
          detail: existing,
          ...base,
        })
        return
      }
      try {
        await fs.access(existing, fs.constants.W_OK)
      } catch {
        checks.push({
          id: `engine:dest:${idSuffix}`,
          label: `${label}: destination is not writable`,
          status: 'fail',
          blocking: true,
          detail: existing,
          ...base,
        })
        return
      }
      const destinationStat = existing === destination ? stat : undefined
      if (destinationStat && !destinationStat.isDirectory()) {
        checks.push({
          id: `engine:dest:${idSuffix}`,
          label: `${label}: destination exists and is not a directory`,
          status: 'fail',
          blocking: true,
          detail: destination,
          ...base,
        })
        return
      }
      const parentMissing = path.dirname(destination) !== existing && destination !== existing
      checks.push({
        id: `engine:dest:${idSuffix}`,
        label: destinationStat
          ? `${label}: destination exists (existing content is reported as collisions)`
          : parentMissing
            ? `${label}: missing parent folders will be created`
            : `${label}: destination is writable`,
        status: destinationStat || parentMissing ? 'warn' : 'pass',
        blocking: false,
        detail: destination,
        ...base,
      })
      if (!checkedVolumes.has(existing)) {
        checkedVolumes.add(existing)
        const free = await freeSpaceBytes(existing)
        if (free === undefined) {
          checks.push({
            id: `engine:space:${idSuffix}`,
            label: `${label}: free space could not be determined`,
            status: 'warn',
            blocking: false,
            detail: existing,
            ...base,
          })
        } else if (free < needed) {
          checks.push({
            id: `engine:space:${idSuffix}`,
            label: `${label}: not enough free space`,
            status: 'fail',
            blocking: true,
            detail: `${formatBytes(needed)} needed, ${formatBytes(free)} available at ${existing}`,
            ...base,
          })
        } else {
          checks.push({
            id: `engine:space:${idSuffix}`,
            label: `${label}: enough free space`,
            status: 'pass',
            blocking: true,
            detail: `${formatBytes(free)} available at ${existing}`,
            ...base,
          })
        }
      }
    }

    for (const target of targets) {
      await destinationCheck(
        target.project.name,
        target.newPath,
        target.project.id,
        target.project.id,
      )
      for (const [i, wt] of target.worktreeNewPaths.entries()) {
        await destinationCheck(
          `${target.project.name} worktree`,
          wt,
          target.project.id,
          `${target.project.id}:wt${i}`,
        )
      }
    }
    if (hasGlobal || targets.length > 0) {
      const claudeDirExists = await pathExists(this.env.claudeConfigDir)
      const ancestor = await nearestExistingAncestor(this.env.claudeConfigDir)
      let writable = false
      if (ancestor) {
        try {
          await fs.access(ancestor, fs.constants.W_OK)
          writable = true
        } catch {
          writable = false
        }
      }
      checks.push({
        id: 'engine:claude-config-dir',
        label: !writable
          ? 'Claude config directory is not writable'
          : claudeDirExists
            ? 'Claude config directory exists'
            : 'Claude config directory will be created if needed',
        status: !writable ? 'fail' : claudeDirExists ? 'pass' : 'warn',
        blocking: hasGlobal && !writable,
        detail: this.env.claudeConfigDir,
      })
    }
    return checks
  }
}

async function nearestExistingAncestor(target: string): Promise<string | undefined> {
  let probe = target
  for (;;) {
    if (await pathExists(probe)) return probe
    const parent = path.dirname(probe)
    if (parent === probe) return undefined
    probe = parent
  }
}

/**
 * Lowest-priority mapping `<source machine home> -> <this machine's home>` so references into the old
 * `~/.claude` (transcript dirs, checkpoint tracking paths) follow the new home when nothing more specific
 * matches. Omitted when the homes are equal or an explicit mapping already covers the old home.
 */
export function implicitHomeMapping(
  manifest: Pick<Manifest, 'machine'>,
  homeDir: string,
  explicit: readonly PathMapping[],
): PathMapping | undefined {
  const oldHome = manifest.machine.homeDir.trim()
  if (!oldHome || !path.isAbsolute(oldHome)) return undefined
  const oldCanonical = canonicalizePath(oldHome, homeDir)
  const newCanonical = canonicalizePath(homeDir, homeDir)
  if (oldCanonical === newCanonical) return undefined
  if (path.parse(oldCanonical).root === oldCanonical) return undefined
  if (explicit.some((m) => canonicalizePath(m.oldPath, homeDir) === oldCanonical)) return undefined
  return { projectId: HOME_MAPPING_PROJECT_ID, oldPath: oldCanonical, newPath: newCanonical }
}

function normalizeStep(
  step: RestoreStep,
  providerId: string,
  projectId: string | undefined,
  unitKey: string,
  seen: Set<string>,
): RestoreStep {
  const base = step.id.startsWith(`${providerId}:`) ? step.id : `${unitKey}:${step.id}`
  let id = base
  let n = 2
  while (seen.has(id)) {
    id = `${base}#${n}`
    n += 1
  }
  seen.add(id)
  return { ...step, id, providerId, ...(projectId ? { projectId } : {}) }
}

export type { CollisionPolicy, Collision }
