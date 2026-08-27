/**
 * In-memory implementation of DevMigrationApi.
 *
 * It simulates the real main process closely enough to develop and test every screen:
 * jobs emit structured progress events with phases and checklist items, backups created in
 * one wizard run can be inspected and restored in the next, passwords are checked, unsupported
 * files are rejected, and collisions appear when a destination already exists. Nothing here
 * touches the filesystem — the renderer has no access to it.
 */
import type { DevMigrationApi, IpcRequest, IpcResponse } from '@devmig/ipc-contracts'
import { IpcChannels, IpcError } from '@devmig/ipc-contracts'
import type {
  BackupHeaderInfo,
  BackupResult,
  CollisionPolicy,
  JobKind,
  JobSnapshot,
  Manifest,
  ProgressEvent,
  RestorePlan,
  RestoreResult,
  ScanSession,
} from '@devmig/model'
import { ErrorCode } from '@devmig/model'
import { basename } from '../lib/paths'
import { log } from '../lib/log'
import {
  MOCK_APP_VERSION,
  MOCK_BACKUP_DIR,
  MOCK_EXISTING_PATHS,
  MOCK_HOME,
  MOCK_PROJECTS_DIR,
  MOCK_PROJECT_PATHS,
  buildMockManifest,
  buildMockRemapReport,
  buildMockRestorePlan,
  buildMockRestoreResult,
  buildMockScanSession,
  defaultSelection,
  mockDiagnostics,
  mockHeaderInfo,
} from './mock-data'

/** Password of the demo backup that `backups.selectFile()` offers first. */
export const MOCK_DEMO_PASSWORD = 'demo-password'
export const MOCK_DEMO_BACKUP_PATH = `${MOCK_BACKUP_DIR}/MacBook Pro — 2026-08-20.devbackup`
export const MOCK_UNSUPPORTED_BACKUP_PATH = `${MOCK_BACKUP_DIR}/old-format-v99.devbackup`

export interface MockApiOptions {
  /** Multiplier applied to every simulated delay. 0 makes jobs complete as fast as the event loop allows. */
  timeScale?: number
  now?: () => Date
}

type ProgressOpts = Partial<Omit<ProgressEvent, 'jobId' | 'message' | 'at'>>

interface RunContext {
  jobId: string
  signal: AbortSignal
  setPhase: (phase: string, message?: string) => void
  progress: (message: string, opts?: ProgressOpts) => void
  sleep: (ms: number) => Promise<void>
}

class MockCancelledError extends Error {
  constructor() {
    super('The operation was cancelled.')
    this.name = 'AbortError'
  }
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T)
}

function serializeMockError(err: unknown): JobSnapshot['error'] {
  if (err instanceof MockCancelledError)
    return { code: 'CANCELLED', message: err.message, recoverable: true }
  if (err instanceof IpcError) {
    const code = ErrorCode.safeParse(err.code)
    return {
      code: code.success ? code.data : 'UNKNOWN',
      message: err.message,
      hint: err.hint,
      details: err.details,
      recoverable: err.recoverable,
    }
  }
  return {
    code: 'UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
    recoverable: false,
  }
}

const MAX_RECENT_EVENTS = 200

class MockJobEngine {
  private readonly jobs = new Map<
    string,
    { snapshot: JobSnapshot; controller: AbortController; done: Promise<void> }
  >()
  private readonly progressListeners = new Map<string, Set<(event: ProgressEvent) => void>>()
  private readonly stateListeners = new Map<string, Set<(snapshot: JobSnapshot) => void>>()
  private counter = 0

  constructor(
    private readonly timeScale: number,
    private readonly now: () => Date,
  ) {}

  start(
    kind: JobKind,
    runner: (ctx: RunContext) => Promise<unknown>,
    initialPhase: string,
  ): JobSnapshot {
    this.counter += 1
    const id = `job_mock_${this.counter}`
    const controller = new AbortController()
    const snapshot: JobSnapshot = {
      id,
      kind,
      status: 'running',
      phase: initialPhase,
      message: 'Starting…',
      startedAt: this.now().toISOString(),
      recentEvents: [],
    }

    const emitProgress = (message: string, opts: ProgressOpts = {}): void => {
      const event: ProgressEvent = {
        jobId: id,
        phase: opts.phase ?? snapshot.phase,
        message,
        level: opts.level ?? 'info',
        at: this.now().toISOString(),
        ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.providerId ? { providerId: opts.providerId } : {}),
        ...(opts.item ? { item: opts.item } : {}),
      }
      snapshot.message = message
      if (opts.progress !== undefined) snapshot.progress = opts.progress
      snapshot.recentEvents.push(event)
      if (snapshot.recentEvents.length > MAX_RECENT_EVENTS)
        snapshot.recentEvents.splice(0, snapshot.recentEvents.length - MAX_RECENT_EVENTS)
      for (const listener of this.progressListeners.get(id) ?? []) listener(clone(event))
    }
    const emitState = (): void => {
      for (const listener of this.stateListeners.get(id) ?? []) listener(clone(snapshot))
    }
    const setPhase = (phase: string, message?: string): void => {
      snapshot.phase = phase
      snapshot.progress = undefined
      emitProgress(message ?? phase, { phase })
      emitState()
    }
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new MockCancelledError())
          return
        }
        const onAbort = (): void => {
          clearTimeout(timer)
          reject(new MockCancelledError())
        }
        const timer = setTimeout(
          () => {
            controller.signal.removeEventListener('abort', onAbort)
            resolve()
          },
          Math.max(0, Math.round(ms * this.timeScale)),
        )
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })

    const ctx: RunContext = {
      jobId: id,
      signal: controller.signal,
      setPhase,
      progress: emitProgress,
      sleep,
    }
    const done = runner(ctx)
      .then((result) => {
        snapshot.status = 'completed'
        snapshot.result = result
        snapshot.finishedAt = this.now().toISOString()
        snapshot.phase = 'COMPLETE'
        emitProgress('Completed', { phase: 'COMPLETE', progress: 1 })
      })
      .catch((err: unknown) => {
        const serialized = serializeMockError(err)
        snapshot.status =
          controller.signal.aborted || serialized?.code === 'CANCELLED' ? 'cancelled' : 'failed'
        snapshot.error = serialized
        snapshot.finishedAt = this.now().toISOString()
        snapshot.phase = snapshot.status === 'cancelled' ? 'CANCELLED' : 'FAILED'
        emitProgress(serialized?.message ?? 'Job failed', {
          phase: snapshot.phase,
          level: snapshot.status === 'cancelled' ? 'warn' : 'error',
        })
      })
      .finally(() => {
        emitState()
      })
    this.jobs.set(id, { snapshot, controller, done })
    return clone(snapshot)
  }

  get(jobId: string): JobSnapshot {
    const entry = this.jobs.get(jobId)
    if (!entry) throw new IpcError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    return clone(entry.snapshot)
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((e) => clone(e.snapshot))
  }

  cancel(jobId: string): JobSnapshot {
    const entry = this.jobs.get(jobId)
    if (!entry) throw new IpcError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    if (entry.snapshot.status !== 'running' && entry.snapshot.status !== 'queued')
      throw new IpcError('JOB_ALREADY_FINISHED', `Job already finished: ${jobId}`)
    entry.controller.abort()
    return clone(entry.snapshot)
  }

  onProgress(jobId: string, listener: (event: ProgressEvent) => void): () => void {
    let set = this.progressListeners.get(jobId)
    if (!set) {
      set = new Set()
      this.progressListeners.set(jobId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  onState(jobId: string, listener: (snapshot: JobSnapshot) => void): () => void {
    let set = this.stateListeners.get(jobId)
    if (!set) {
      set = new Set()
      this.stateListeners.set(jobId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  async waitFor(jobId: string): Promise<JobSnapshot> {
    const entry = this.jobs.get(jobId)
    if (!entry) throw new IpcError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    await entry.done
    return clone(entry.snapshot)
  }
}

interface StoredBackup {
  path: string
  password: string
  manifest: Manifest
  sizeBytes: number
  createdAt: string
}

interface StoredPlan {
  plan: RestorePlan
  backup: StoredBackup
  includeGlobal: boolean
}

function invalid(message: string, hint?: string): IpcError {
  return new IpcError('INVALID_INPUT', message, hint, undefined, true)
}

function formatDateForName(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function createMockApi(options: MockApiOptions = {}): DevMigrationApi {
  const timeScale = options.timeScale ?? 1
  const now = options.now ?? ((): Date => new Date())
  const engine = new MockJobEngine(timeScale, now)
  const scans = new Map<string, ScanSession>()
  const backups = new Map<string, StoredBackup>()
  const plans = new Map<string, StoredPlan>()
  const restoredPaths = new Set<string>()
  let scanCounter = 0
  let planCounter = 0
  let manifestCounter = 0
  let pickCounter = 0
  let fileCounter = 0
  let lastCreatedBackup: string | null = null

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms * timeScale))))

  // Demo backup available before the user creates one.
  {
    const createdAt = '2026-08-20T09:12:00.000Z'
    const demoScan = buildMockScanSession(MOCK_PROJECT_PATHS, true, 'scan_demo', createdAt)
    const manifest = buildMockManifest(
      demoScan,
      new Set(defaultSelection(demoScan)),
      'MacBook Pro — 2026-08-20',
      createdAt,
      'bk_demo',
    )
    backups.set(MOCK_DEMO_BACKUP_PATH, {
      path: MOCK_DEMO_BACKUP_PATH,
      password: MOCK_DEMO_PASSWORD,
      manifest,
      sizeBytes: Math.round(manifest.stats.payloadBytes * 0.42),
      createdAt,
    })
  }

  function pathInfo(p: string): IpcResponse<'system:pathExists'> {
    const normalized = p.replace(/\/+$/, '')
    const known = MOCK_EXISTING_PATHS[normalized]
    if (known) return { exists: true, isDirectory: known.isDirectory, isEmpty: known.isEmpty }
    if (backups.has(normalized)) return { exists: true, isDirectory: false, isEmpty: false }
    if (restoredPaths.has(normalized)) return { exists: true, isDirectory: true, isEmpty: false }
    if (normalized === MOCK_UNSUPPORTED_BACKUP_PATH)
      return { exists: true, isDirectory: false, isEmpty: false }
    return { exists: false, isDirectory: false, isEmpty: true }
  }

  function requireBackup(path: string, password: string): StoredBackup {
    if (path === MOCK_UNSUPPORTED_BACKUP_PATH)
      throw new IpcError(
        'ARCHIVE_UNSUPPORTED_VERSION',
        'This backup was created with a newer format (version 99) than this app understands.',
        'Update Dev Migration Assistant to a version that supports this backup format.',
        { formatVersion: 99, supported: [1] },
      )
    const backup = backups.get(path)
    if (!backup)
      throw new IpcError(
        'PATH_NOT_FOUND',
        `No backup file at ${path}`,
        'Choose a .devbackup file.',
        {
          path,
        },
      )
    if (backup.password !== password)
      throw new IpcError(
        'ARCHIVE_AUTH_FAILED',
        'That password did not unlock this backup.',
        'Passwords are case-sensitive. The file itself was not modified.',
        undefined,
        true,
      )
    return backup
  }

  const api: DevMigrationApi = {
    projects: {
      async selectDirectories(input?: IpcRequest<'projects:selectDirectories'>) {
        await sleep(120)
        const cycle = pickCounter % 3
        pickCounter += 1
        if (cycle === 0) return { paths: MOCK_PROJECT_PATHS, cancelled: false }
        if (cycle === 1)
          return {
            paths: [`${input?.defaultPath ?? MOCK_PROJECTS_DIR}/scratch-notes`],
            cancelled: false,
          }
        return { paths: [], cancelled: true }
      },
      async scan(input) {
        await sleep(30)
        const parsed = IpcChannels['projects:scan'].request.safeParse(input)
        if (!parsed.success) throw invalid('Invalid scan request.', parsed.error.message)
        const { paths, includeGlobal } = parsed.data
        scanCounter += 1
        const scanId = `scan_${scanCounter}`
        const snapshot = engine.start(
          'scan',
          async (ctx) => {
            ctx.setPhase('DISCOVERING', 'Discovering projects…')
            for (const p of paths) {
              await ctx.sleep(180)
              ctx.progress(`Found ${basename(p)} at ${p}`)
            }
            const session = buildMockScanSession(paths, includeGlobal, scanId, now().toISOString())
            ctx.setPhase('SCANNING', 'Scanning projects…')
            const providerLabels: Record<string, string> = {
              git: 'Git',
              'claude-code': 'Claude Code',
              'project-files': 'Project files',
              runtime: 'Runtime',
            }
            for (const project of session.projects) {
              const pid = project.project.id
              for (const result of project.providers) {
                const label = providerLabels[result.providerId] ?? result.providerId
                ctx.progress(`${project.project.name}: scanning ${label.toLowerCase()}`, {
                  projectId: pid,
                  providerId: result.providerId,
                  item: { id: `${pid}:${result.providerId}`, label, status: 'running' },
                })
                await ctx.sleep(result.providerId === 'claude-code' ? 420 : 200)
                const detail =
                  result.summary[0]?.label ?? (result.detected ? 'done' : 'nothing found')
                ctx.progress(`${project.project.name}: ${label} — ${detail}`, {
                  projectId: pid,
                  providerId: result.providerId,
                  level: result.detected ? 'info' : 'debug',
                  item: {
                    id: `${pid}:${result.providerId}`,
                    label,
                    status: result.detected ? 'done' : 'skipped',
                  },
                })
              }
              for (const w of project.warnings) ctx.progress(w, { projectId: pid, level: 'warn' })
            }
            if (includeGlobal) {
              ctx.progress('Scanning global Claude Code environment', {
                providerId: 'claude-code',
                item: {
                  id: 'global:claude-code',
                  label: 'Global Claude Code environment',
                  status: 'running',
                },
              })
              await ctx.sleep(360)
              ctx.progress('Global Claude Code environment: settings, memory, plugins, history', {
                providerId: 'claude-code',
                item: {
                  id: 'global:claude-code',
                  label: 'Global Claude Code environment',
                  status: 'done',
                },
              })
            }
            scans.set(scanId, session)
            return session
          },
          'DISCOVERING',
        )
        return { jobId: snapshot.id }
      },
    },
    backups: {
      async selectOutputPath(input) {
        await sleep(120)
        const name = input.suggestedName.endsWith('.devbackup')
          ? input.suggestedName
          : `${input.suggestedName}.devbackup`
        return { path: `${MOCK_BACKUP_DIR}/${name}`, cancelled: false }
      },
      async create(input) {
        await sleep(30)
        const parsed = IpcChannels['backups:create'].request.safeParse(input)
        if (!parsed.success)
          throw invalid('The backup request is incomplete.', parsed.error.issues[0]?.message)
        const request = parsed.data
        const scan = scans.get(request.scanId)
        if (!scan)
          throw invalid(`Unknown scan session: ${request.scanId}`, 'Run the project scan again.')
        const selected = new Set(request.selectedArtifactIds)
        const snapshot = engine.start(
          'backup',
          async (ctx) => {
            ctx.setPhase('COLLECTING', 'Collecting artifacts from providers')
            for (const project of scan.projects) {
              const pid = project.project.id
              const has = (providerId: string): boolean =>
                project.providers.some(
                  (r) => r.providerId === providerId && r.artifacts.some((a) => selected.has(a.id)),
                )
              const steps: { id: string; label: string; providerId: string; ms: number }[] = []
              if (has('git')) {
                steps.push({ id: 'git-bundle', label: 'Git bundle', providerId: 'git', ms: 700 })
                steps.push({ id: 'worktree', label: 'Working tree', providerId: 'git', ms: 350 })
              }
              if (has('claude-code'))
                steps.push({
                  id: 'claude-sessions',
                  label: 'Claude Code sessions',
                  providerId: 'claude-code',
                  ms: 900,
                })
              if (has('project-files'))
                steps.push({
                  id: 'project-files',
                  label: 'Project files',
                  providerId: 'project-files',
                  ms: 200,
                })
              if (has('runtime'))
                steps.push({ id: 'runtime', label: 'Runtime facts', providerId: 'runtime', ms: 80 })
              for (const step of steps) {
                ctx.progress(`${project.project.name}: ${step.label}`, {
                  projectId: pid,
                  providerId: step.providerId,
                  item: { id: `${pid}:${step.id}`, label: step.label, status: 'running' },
                })
                await ctx.sleep(step.ms)
                ctx.progress(`${project.project.name}: ${step.label} captured`, {
                  projectId: pid,
                  providerId: step.providerId,
                  item: { id: `${pid}:${step.id}`, label: step.label, status: 'done' },
                })
              }
            }
            if (scan.global.some((r) => r.artifacts.some((a) => selected.has(a.id)))) {
              ctx.progress('Global Claude Code environment', {
                providerId: 'claude-code',
                item: {
                  id: 'global:claude',
                  label: 'Global Claude Code environment',
                  status: 'running',
                },
              })
              await ctx.sleep(400)
              ctx.progress('Global Claude Code environment captured', {
                providerId: 'claude-code',
                item: {
                  id: 'global:claude',
                  label: 'Global Claude Code environment',
                  status: 'done',
                },
              })
            }
            const createdAt = now().toISOString()
            manifestCounter += 1
            const manifest = buildMockManifest(
              scan,
              selected,
              request.label,
              createdAt,
              `bk_${manifestCounter}`,
            )
            const sizeBytes = Math.round(manifest.stats.payloadBytes * 0.42)

            ctx.setPhase('PACKING', 'Packing payload')
            ctx.progress('Writing tar stream', {
              item: { id: 'pack', label: 'Packing', status: 'running' },
            })
            for (let i = 1; i <= 4; i += 1) {
              await ctx.sleep(220)
              ctx.progress(`Packed ${Math.round((manifest.stats.payloadBytes * i) / 4 / 1e6)} MB`, {
                progress: i / 4,
              })
            }
            ctx.progress('Payload packed', {
              item: { id: 'pack', label: 'Packing', status: 'done' },
            })

            ctx.setPhase('ENCRYPTING', 'Encrypting with AES-256-GCM')
            ctx.progress('Deriving key with Argon2id', {
              item: { id: 'encrypt', label: 'Encrypting', status: 'running' },
            })
            await ctx.sleep(600)
            for (let i = 1; i <= 5; i += 1) {
              await ctx.sleep(200)
              ctx.progress(`Encrypted chunk ${i * 12} of 60`, { progress: i / 5 })
            }
            ctx.progress('Encrypted', {
              item: { id: 'encrypt', label: 'Encrypting', status: 'done' },
            })

            ctx.setPhase('VERIFYING', 'Re-reading the file to verify every chunk')
            ctx.progress('Verifying', {
              item: { id: 'verify', label: 'Verifying', status: 'running' },
            })
            for (let i = 1; i <= 3; i += 1) {
              await ctx.sleep(180)
              ctx.progress(`Verified ${i * 20} of 60 chunks`, { progress: i / 3 })
            }
            ctx.progress('All chunks and checksums verified', {
              item: { id: 'verify', label: 'Verifying', status: 'done' },
            })

            backups.set(request.outputPath, {
              path: request.outputPath,
              password: request.password,
              manifest,
              sizeBytes,
              createdAt,
            })
            lastCreatedBackup = request.outputPath
            const result: BackupResult = {
              outputPath: request.outputPath,
              sizeBytes,
              manifest,
              verified: true,
              durationMs:
                Math.max(1, Date.parse(now().toISOString()) - Date.parse(createdAt)) + 6200,
              warnings: [],
            }
            return result
          },
          'COLLECTING',
        )
        return { jobId: snapshot.id }
      },
      async selectFile() {
        await sleep(120)
        const cycle = fileCounter % 3
        fileCounter += 1
        if (cycle === 0)
          return { path: lastCreatedBackup ?? MOCK_DEMO_BACKUP_PATH, cancelled: false }
        if (cycle === 1) return { path: MOCK_UNSUPPORTED_BACKUP_PATH, cancelled: false }
        return { path: null, cancelled: true }
      },
      async readHeader(input) {
        await sleep(80)
        if (input.path === MOCK_UNSUPPORTED_BACKUP_PATH)
          return mockHeaderInfo(input.path, 12_400_000, '2025-01-04T10:00:00.000Z')
        const backup = backups.get(input.path)
        if (!backup)
          throw new IpcError('PATH_NOT_FOUND', `No backup file at ${input.path}`, undefined, {
            path: input.path,
          })
        const header: BackupHeaderInfo = mockHeaderInfo(
          backup.path,
          backup.sizeBytes,
          backup.createdAt,
        )
        return header
      },
      async inspect(input) {
        await sleep(650) // Argon2id
        const backup = requireBackup(input.path, input.password)
        return {
          path: backup.path,
          sizeBytes: backup.sizeBytes,
          formatVersion: backup.manifest.formatVersion,
          manifest: clone(backup.manifest),
        }
      },
      async verify(input) {
        await sleep(30)
        const snapshot = engine.start(
          'verify',
          async (ctx) => {
            ctx.setPhase('INSPECT', 'Reading header')
            await ctx.sleep(200)
            ctx.setPhase('DECRYPT', 'Deriving key and unwrapping master key')
            await ctx.sleep(500)
            const backup = requireBackup(input.path, input.password)
            ctx.setPhase('VALIDATE', 'Streaming through every chunk')
            const entries = backup.manifest.stats.artifactCount * 37 + 2
            for (let i = 1; i <= 5; i += 1) {
              await ctx.sleep(220)
              ctx.progress(`Verified ${i * 12} of 60 chunks`, { progress: i / 5 })
            }
            return { ok: true, entries, bytes: backup.manifest.stats.payloadBytes }
          },
          'INSPECT',
        )
        return { jobId: snapshot.id }
      },
    },
    restore: {
      async selectDestination(input?: IpcRequest<'restore:selectDestination'>) {
        await sleep(120)
        const name = basename(input?.defaultPath ?? '') || 'project'
        return { path: `${MOCK_HOME}/Projects/${name}`, cancelled: false }
      },
      async previewRemap(input) {
        const parsed = IpcChannels['restore:previewRemap'].request.safeParse(input)
        if (!parsed.success) throw invalid('Invalid remap preview request.')
        await sleep(160)
        const backup = requireBackup(parsed.data.path, parsed.data.password)
        return buildMockRemapReport(backup.manifest, parsed.data.mappings)
      },
      async plan(input) {
        await sleep(30)
        const parsed = IpcChannels['restore:plan'].request.safeParse(input)
        if (!parsed.success)
          throw invalid('The restore request is incomplete.', parsed.error.issues[0]?.message)
        const request = parsed.data
        const snapshot = engine.start(
          'restore-plan',
          async (ctx) => {
            ctx.setPhase('INSPECT', 'Reading backup header')
            await ctx.sleep(200)
            ctx.setPhase('DECRYPT', 'Decrypting payload to a private staging directory')
            const backup = requireBackup(request.backupPath, request.password)
            for (let i = 1; i <= 4; i += 1) {
              await ctx.sleep(260)
              ctx.progress(`Decrypted ${i * 15} of 60 chunks`, { progress: i / 4 })
            }
            ctx.setPhase('VALIDATE', 'Validating manifest and checksums')
            await ctx.sleep(380)
            ctx.progress('Manifest valid · 1,204 entries · checksums match')
            ctx.setPhase('MAP_PATHS', 'Computing path mappings')
            await ctx.sleep(220)
            ctx.setPhase('PREFLIGHT', 'Running preflight checks')
            await ctx.sleep(420)
            planCounter += 1
            const planId = `plan_${planCounter}`
            const plan = buildMockRestorePlan(
              planId,
              request.backupPath,
              backup.manifest,
              request.mappings,
              new Set(request.selectedArtifactIds),
              request.options.includeGlobal,
              now().toISOString(),
              (p) => pathInfo(p),
            )
            plans.set(planId, { plan, backup, includeGlobal: request.options.includeGlobal })
            return plan
          },
          'INSPECT',
        )
        return { jobId: snapshot.id }
      },
      async execute(input) {
        await sleep(30)
        const parsed = IpcChannels['restore:execute'].request.safeParse(input)
        if (!parsed.success) throw invalid('Invalid restore execution request.')
        const stored = plans.get(parsed.data.planId)
        if (!stored)
          throw new IpcError(
            'RESTORE_PLAN_REJECTED',
            `Unknown plan: ${parsed.data.planId}`,
            'Plan the restore again.',
          )
        const decisions: Record<string, CollisionPolicy> = { ...parsed.data.collisionDecisions }
        const { plan, backup } = stored
        const snapshot = engine.start(
          'restore',
          async (ctx) => {
            const started = Date.parse(now().toISOString())
            ctx.setPhase('STAGE', 'Extracting payload to private staging')
            for (let i = 1; i <= 3; i += 1) {
              await ctx.sleep(240)
              ctx.progress(`Extracted ${i * 20} of 60 chunks`, { progress: i / 3 })
            }
            const policyFor = (kind: string, projectId: string): CollisionPolicy | null => {
              const project = plan.projects.find((p) => p.projectId === projectId)
              const collision = project?.collisions.find((c) => c.kind === kind)
              if (!collision) return null
              return decisions[collision.id] ?? collision.policy
            }
            const runProjectPhase = async (
              phase: string,
              phaseMessage: string,
              providerId: string,
              itemId: string,
              label: string,
              collisionKind: string | null,
              ms: number,
            ): Promise<void> => {
              ctx.setPhase(phase, phaseMessage)
              for (const project of plan.projects) {
                if (!project.steps.some((s) => s.providerId === providerId)) continue
                const policy = collisionKind ? policyFor(collisionKind, project.projectId) : null
                const skipped = policy === 'skip'
                ctx.progress(`${project.name}: ${label}`, {
                  projectId: project.projectId,
                  providerId,
                  item: {
                    id: `${project.projectId}:${itemId}`,
                    label,
                    status: skipped ? 'skipped' : 'running',
                  },
                })
                if (skipped) {
                  ctx.progress(`${project.name}: ${label} skipped (existing data kept)`, {
                    projectId: project.projectId,
                    providerId,
                    level: 'warn',
                    item: { id: `${project.projectId}:${itemId}`, label, status: 'skipped' },
                  })
                  continue
                }
                await ctx.sleep(ms)
                ctx.progress(`${project.name}: ${label} done`, {
                  projectId: project.projectId,
                  providerId,
                  item: {
                    id: `${project.projectId}:${itemId}`,
                    label,
                    status: policy === 'merge' ? 'warn' : 'done',
                  },
                })
              }
            }
            await runProjectPhase(
              'RESTORE_REPOSITORIES',
              'Cloning repositories from bundles',
              'git',
              'git',
              'Repository',
              'git-repo-exists',
              800,
            )
            await runProjectPhase(
              'RESTORE_WORKTREE_STATE',
              'Recreating worktrees and applying local changes',
              'git',
              'worktree',
              'Worktree state',
              'git-repo-exists',
              500,
            )
            await runProjectPhase(
              'RESTORE_CLAUDE',
              'Restoring Claude Code sessions with safe path remapping',
              'claude-code',
              'claude',
              'Claude Code',
              'claude-project-exists',
              900,
            )
            if (plan.globalSteps.length > 0) {
              ctx.progress('Global Claude Code environment', {
                providerId: 'claude-code',
                item: {
                  id: 'global:claude',
                  label: 'Global Claude Code environment',
                  status: 'running',
                },
              })
              await ctx.sleep(300)
              ctx.progress('Global Claude Code environment merged', {
                providerId: 'claude-code',
                item: {
                  id: 'global:claude',
                  label: 'Global Claude Code environment',
                  status: 'done',
                },
              })
            }
            await runProjectPhase(
              'RESTORE_PROJECT_FILES',
              'Restoring local project files',
              'project-files',
              'files',
              'Project files',
              null,
              250,
            )
            ctx.setPhase('VERIFY', 'Verifying git status, worktrees and transcripts')
            for (let i = 1; i <= 3; i += 1) {
              await ctx.sleep(260)
              ctx.progress(`Verification ${i} of 3`, { progress: i / 3 })
            }
            ctx.setPhase('REPORT', 'Writing migration report')
            await ctx.sleep(150)
            for (const project of plan.projects) restoredPaths.add(project.newPath)
            const durationMs = Math.max(1, Date.parse(now().toISOString()) - started)
            const result: RestoreResult = buildMockRestoreResult(
              plan,
              backup.manifest,
              decisions,
              durationMs,
            )
            return result
          },
          'STAGE',
        )
        return { jobId: snapshot.id }
      },
    },
    jobs: {
      // Wrapped so synchronous failures become rejections, exactly like an IPC invoke would.
      get: (jobId) => Promise.resolve().then(() => engine.get(jobId)),
      cancel: (jobId) => Promise.resolve().then(() => engine.cancel(jobId)),
      list: () => Promise.resolve().then(() => engine.list()),
      onProgress: (jobId, listener) => engine.onProgress(jobId, listener),
      onState: (jobId, listener) => engine.onState(jobId, listener),
      waitFor: (jobId) => engine.waitFor(jobId),
    },
    system: {
      async openInFinder(path) {
        log.info('mock: reveal in Finder', { path })
        await sleep(60)
        return { ok: true }
      },
      async openInTerminal(path) {
        log.info('mock: open in Terminal', { path })
        await sleep(60)
        return { ok: true }
      },
      async openExternal(url) {
        log.info('mock: open external', { url })
        await sleep(60)
        return { ok: true }
      },
      async diagnostics() {
        await sleep(90)
        return mockDiagnostics(now().toISOString())
      },
      async copyDiagnostics() {
        const report = JSON.stringify(mockDiagnostics(now().toISOString()), null, 2)
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard)
            await navigator.clipboard.writeText(report)
        } catch {
          /* clipboard is unavailable in some sandboxes; the real bridge copies in main */
        }
        return { ok: true }
      },
      async openLogs() {
        log.info('mock: open logs directory')
        await sleep(60)
        return { ok: true }
      },
      async suggestBackupName() {
        await sleep(30)
        return {
          name: `MacBook Pro — ${formatDateForName(now())}`,
          defaultDirectory: MOCK_BACKUP_DIR,
        }
      },
      async homeDir() {
        await sleep(10)
        return { homeDir: MOCK_HOME, defaultProjectsDir: MOCK_PROJECTS_DIR }
      },
      async pathExists(path) {
        await sleep(40)
        return pathInfo(path)
      },
    },
    meta: { appVersion: MOCK_APP_VERSION, platform: 'darwin', isE2E: false },
  }
  return api
}
