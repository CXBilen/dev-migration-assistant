/**
 * Test-only fixtures for the core engines: temp roots, a fake Environment pointing at a throw-away home,
 * a collecting logger, a JobManager harness and two configurable fake providers (one project-scoped, one
 * user-wide). Nothing here touches the real home directory. Not exported from the package index.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AttentionItem,
  Collision,
  JobKind,
  ManifestArtifact,
  ProgressEvent,
  ProjectDescriptor,
  ProviderScanResult,
  RestoreStep,
  ResultItem,
  ScannedArtifact,
  VerificationCheck,
} from '@devmig/model'
import {
  MigrationError,
  createLogger,
  realExec,
  throwIfAborted,
  type Exec,
  type LogRecord,
  type Logger,
} from '@devmig/shared'
import type { Environment } from '../environment'
import { JobManager, type JobRunContext, type JobRunner } from '../jobs/job-manager'
import type {
  BackupContext,
  MigrationProvider,
  ProviderBackupInput,
  ProviderBackupOutput,
  ProviderDetection,
  ProviderRestoreInput,
  ProviderRestorePlan,
  ProviderRestoreResult,
  ProviderVerification,
  ProviderVerifyInput,
  RestoreContext,
  RestorePlanningContext,
  ScanContext,
  VerifyContext,
} from '../providers/contract'
import { createFakeExec, type FakeExec } from './fake-exec'

// ---------------------------------------------------------------- temp dirs / env / logging

export interface TempRoot {
  root: string
  cleanup: () => Promise<void>
}

/** Private temp directory (symlink-resolved so macOS /var → /private/var comparisons hold). */
export async function makeTempRoot(prefix = 'devmig-core-'): Promise<TempRoot> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const root = await fs.realpath(created)
  await fs.chmod(root, 0o700)
  return {
    root,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

export interface CollectingLogger {
  logger: Logger
  records: LogRecord[]
}

export function collectingLogger(): CollectingLogger {
  const records: LogRecord[] = []
  return { logger: createLogger((r) => records.push(r)), records }
}

export interface TestEnvOptions {
  exec?: Exec
  /** Use the real `git`/`node` binaries instead of the "nothing installed" fake exec. */
  realExec?: boolean
  logger?: Logger
  env?: Record<string, string | undefined>
}

export interface TestEnv {
  env: Environment
  homeDir: string
  claudeConfigDir: string
  claudeJsonPath: string
  fakeExec: FakeExec | undefined
  records: LogRecord[]
}

/** An Environment whose home, Claude config dir and ~/.claude.json live under `root`. */
export async function makeTestEnv(root: string, options: TestEnvOptions = {}): Promise<TestEnv> {
  const homeDir = path.join(root, 'home')
  const claudeConfigDir = path.join(homeDir, '.claude')
  const claudeJsonPath = path.join(homeDir, '.claude.json')
  await fs.mkdir(claudeConfigDir, { recursive: true, mode: 0o700 })
  const logging = collectingLogger()
  const fakeExec = options.exec || options.realExec ? undefined : createFakeExec(() => undefined)
  const exec = options.exec ?? (options.realExec || !fakeExec ? realExec : fakeExec)
  return {
    env: {
      homeDir,
      claudeConfigDir,
      claudeJsonPath,
      env: options.env ?? { HOME: homeDir, PATH: process.env.PATH },
      exec,
      logger: options.logger ?? logging.logger,
    },
    homeDir,
    claudeConfigDir,
    claudeJsonPath,
    fakeExec,
    records: logging.records,
  }
}

// ---------------------------------------------------------------- job harness

export interface JobHarness {
  jobs: JobManager
  events: ProgressEvent[]
  /** Starts a job and resolves with its typed result (throws the serialized error on failure). */
  run<T>(kind: JobKind, runner: JobRunner<T>): Promise<T>
}

export function makeJobHarness(logger: Logger): JobHarness {
  const jobs = new JobManager(logger)
  const events: ProgressEvent[] = []
  jobs.on('progress', (e) => events.push(e))
  return {
    jobs,
    events,
    run: async <T>(kind: JobKind, runner: JobRunner<T>): Promise<T> => {
      const snapshot = jobs.start(kind, runner)
      return jobs.result<T>(snapshot.id)
    },
  }
}

/** A JobRunContext outside the JobManager (unit tests that call engines directly). */
export function directJobContext(
  logger: Logger,
  options: { signal?: AbortSignal; events?: ProgressEvent[] } = {},
): JobRunContext {
  const events = options.events ?? []
  let phase = 'IDLE'
  return {
    jobId: 'job_test',
    signal: options.signal ?? new AbortController().signal,
    logger,
    progress: (message, opts = {}) => {
      events.push({
        jobId: 'job_test',
        phase: opts.phase ?? phase,
        message,
        level: opts.level ?? 'info',
        at: new Date().toISOString(),
        ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.providerId ? { providerId: opts.providerId } : {}),
        ...(opts.item ? { item: opts.item } : {}),
      })
    },
    setPhase: (p, message) => {
      phase = p
      events.push({ jobId: 'job_test', phase: p, message: message ?? p, level: 'info', at: '' })
    },
  }
}

// ---------------------------------------------------------------- fake project-scoped provider

export interface FileProviderOptions {
  id?: string
  displayName?: string
  schemaVersion?: number
  /** File names (top-level of the project) the provider looks for. Default: every `*.txt`. */
  match?: (name: string) => boolean
  /** Awaited inside createBackupArtifacts before anything is written (cancellation tests). */
  beforeBackup?: (input: ProviderBackupInput, ctx: BackupContext) => Promise<void>
  /** Throw from scanProject. */
  failScan?: Error
  /** Throw from restore(). */
  failRestore?: Error
  /** Attempt to write outside the approved roots during restore (ScopedFs must reject it). */
  escapeOnRestore?: boolean
  /** Attempt to write outside the staging dir during backup (ScopedFs must reject it). */
  escapeOnBackup?: boolean
  /** Extra summary keys returned from createBackupArtifacts (e.g. sessionCount). */
  summary?: Record<string, unknown>
  restoreHints?: Record<string, unknown>
  /** Attention items reported after restore. */
  attention?: AttentionItem[]
  /** Return an artifact id that is NOT namespaced to test engine prefixing (default: namespaced). */
  rawArtifactIds?: boolean
  /** Produce the same artifact id twice (duplicate-id test). */
  duplicateIds?: boolean
  /** Declare the aside path convention in the plan state. */
  announceAsidePaths?: boolean
  /** Plan-level warnings to report. */
  planWarnings?: string[]
}

interface FileEntry {
  rel: string
  payloadPath: string
  dest: string
  collisionId: string | null
}

export interface FileProviderCalls {
  scan: number
  backup: number
  plan: number
  restore: number
  verify: number
  lastRestoreCtx?: RestoreContext
  lastPlanCtx?: RestorePlanningContext
}

export interface FakeFileProvider extends MigrationProvider {
  calls: FileProviderCalls
}

async function listMatching(dir: string, match: (name: string) => boolean): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && match(e.name))
    .map((e) => e.name)
    .sort()
}

/**
 * Project-scoped provider: backs up matching top-level files (kind 'file') plus a `settings.json`
 * json-fragment when present; restores them under the mapped project path; reports collisions for
 * existing destinations (skip | backup-then-replace).
 */
export function createFileProvider(options: FileProviderOptions = {}): FakeFileProvider {
  const id = options.id ?? 'files'
  const match = options.match ?? ((name: string) => name.endsWith('.txt'))
  const calls: FileProviderCalls = { scan: 0, backup: 0, plan: 0, restore: 0, verify: 0 }
  const artifactId = (projectId: string, rel: string): string =>
    options.rawArtifactIds ? `${projectId}:${rel}` : `${id}:${projectId}:${rel}`

  const provider: FakeFileProvider = {
    id,
    displayName: options.displayName ?? 'Fake files',
    version: '0.0.1-test',
    schemaVersion: options.schemaVersion ?? 1,
    supportsGlobal: false,
    calls,

    detect(): Promise<ProviderDetection> {
      return Promise.resolve({ providerId: id, available: true, details: {}, notes: [] })
    },

    async scanProject(project: ProjectDescriptor, ctx: ScanContext): Promise<ProviderScanResult> {
      calls.scan += 1
      throwIfAborted(ctx.signal)
      if (options.failScan) throw options.failScan
      const names = await listMatching(project.realPath, match)
      const artifacts: ScannedArtifact[] = []
      for (const name of names) {
        const abs = path.join(project.realPath, name)
        const size = (await fs.stat(abs)).size
        const sensitive = name.includes('.env') || name.includes('secret')
        artifacts.push({
          id: artifactId(project.id, name),
          providerId: id,
          projectId: project.id,
          scope: 'project',
          kind: 'file',
          label: name,
          sourcePath: abs,
          sizeBytes: size,
          count: 1,
          sensitivity: sensitive ? 'sensitive' : 'safe',
          includedByDefault: !sensitive,
          selectable: true,
          reasons: sensitive ? ['looks sensitive'] : [],
          meta: { rel: name },
        })
      }
      try {
        const settings = path.join(project.realPath, 'settings.json')
        const size = (await fs.stat(settings)).size
        artifacts.push({
          id: artifactId(project.id, 'settings'),
          providerId: id,
          projectId: project.id,
          scope: 'project',
          kind: 'json-fragment',
          label: 'settings.json',
          sourcePath: settings,
          sizeBytes: size,
          sensitivity: 'safe',
          includedByDefault: true,
          selectable: true,
          reasons: [],
          meta: { rel: 'settings.json' },
        })
      } catch {
        // no settings.json
      }
      if (options.duplicateIds && artifacts[0]) artifacts.push({ ...artifacts[0] })
      return {
        providerId: id,
        projectId: project.id,
        detected: artifacts.length > 0,
        artifacts,
        summary: [{ label: `${artifacts.length} file(s)`, status: 'ok' }],
        warnings: [],
        estimatedBytes: artifacts.reduce((n, a) => n + (a.sizeBytes ?? 0), 0),
      }
    },

    async createBackupArtifacts(
      input: ProviderBackupInput,
      ctx: BackupContext,
    ): Promise<ProviderBackupOutput> {
      calls.backup += 1
      if (options.beforeBackup) await options.beforeBackup(input, ctx)
      throwIfAborted(ctx.signal)
      if (options.escapeOnBackup) {
        await ctx.fs.writeFile(path.join(ctx.stagingDir, '..', 'escape.txt'), 'nope')
      }
      const artifacts: ManifestArtifact[] = []
      let bytes = 0
      for (const artifact of input.artifacts) {
        const rel = String(artifact.meta.rel)
        const src = artifact.sourcePath as string
        const stagingRel =
          artifact.kind === 'json-fragment' ? 'fragments/settings.json' : `files/${rel}`
        const target = path.join(ctx.stagingDir, ...stagingRel.split('/'))
        if (artifact.kind === 'json-fragment') {
          const raw = JSON.parse(await fs.readFile(src, 'utf8')) as Record<string, unknown>
          await ctx.fs.writeFileAtomic(target, JSON.stringify({ fragment: raw }, null, 2))
        } else {
          await ctx.fs.copyFileAtomic(src, target)
        }
        const size = (await fs.stat(target)).size
        bytes += size
        artifacts.push({
          id: artifact.id,
          providerId: id,
          kind: artifact.kind,
          label: artifact.label,
          payloadPath: ctx.payloadPathFor(stagingRel),
          sizeBytes: size,
          fileCount: 1,
          sensitivity: artifact.sensitivity,
          sourcePath: src,
          meta: { rel },
        })
        ctx.progress(`✓ ${artifact.label}`, undefined, {
          id: `${input.project?.id ?? 'global'}:${rel}`,
          label: artifact.label,
          status: 'done',
        })
      }
      return {
        artifacts,
        schemaVersion: options.schemaVersion ?? 1,
        summary: { fileCount: artifacts.length, bytes, ...(options.summary ?? {}) },
        ...(options.restoreHints ? { restoreHints: options.restoreHints } : {}),
        warnings: [],
      }
    },

    async planRestore(
      input: ProviderRestoreInput,
      ctx: RestorePlanningContext,
    ): Promise<ProviderRestorePlan> {
      calls.plan += 1
      calls.lastPlanCtx = ctx
      const project = input.project
      if (!project) throw new MigrationError('INVALID_INPUT', 'files provider is project-scoped')
      const files: FileEntry[] = []
      const collisions: Collision[] = []
      const steps: RestoreStep[] = []
      let rewrites = 0
      for (const artifact of input.artifacts) {
        const rel = String(artifact.meta.rel)
        const dest = path.join(project.newPath, rel)
        const mapped = artifact.sourcePath ? ctx.mapPath(artifact.sourcePath) : undefined
        if (mapped?.changed) rewrites += 1
        let collisionId: string | null = null
        try {
          await fs.stat(dest)
          collisionId = rel
          collisions.push({
            id: rel,
            providerId: id,
            projectId: project.id,
            kind: 'file-exists',
            path: dest,
            detail: `${rel} already exists`,
            allowedPolicies: ['skip', 'backup-then-replace'],
            policy: 'skip',
          })
        } catch {
          // no collision
        }
        files.push({
          rel,
          payloadPath: path.join(ctx.payloadRoot, ...artifact.payloadPath.split('/')),
          dest,
          collisionId,
        })
        steps.push({
          id: rel,
          providerId: id,
          projectId: project.id,
          label: `Restore ${rel}`,
          destination: dest,
          artifactIds: [artifact.id],
        })
      }
      const state: Record<string, unknown> = { files }
      if (options.announceAsidePaths) {
        state.asidePaths = [`${project.newPath}.devmig-backup-test`]
      }
      return {
        providerId: id,
        projectId: project.id,
        steps,
        collisions,
        preflight: [
          {
            id: 'ready',
            label: 'Fake files ready',
            status: 'pass',
            blocking: true,
            providerId: id,
          },
        ],
        remap: {
          affected: [{ label: 'file references', count: rewrites }],
          safeRewriteCount: rewrites,
          warnings: [],
          unsupportedReferences: [],
        },
        warnings: options.planWarnings ?? [],
        state,
      }
    },

    async restore(
      plan: ProviderRestorePlan,
      input: ProviderRestoreInput,
      ctx: RestoreContext,
    ): Promise<ProviderRestoreResult> {
      calls.restore += 1
      calls.lastRestoreCtx = ctx
      if (options.failRestore) throw options.failRestore
      const project = input.project
      if (!project) throw new MigrationError('INVALID_INPUT', 'files provider is project-scoped')
      if (options.escapeOnRestore) {
        await ctx.fs.writeFile(path.join(project.newPath, '..', 'escaped.txt'), 'nope')
      }
      const files = plan.state.files as FileEntry[]
      const items: ResultItem[] = []
      const restored: string[] = []
      for (const file of files) {
        throwIfAborted(ctx.signal)
        const policy = file.collisionId ? ctx.collisionDecisions[file.collisionId] : undefined
        if (file.collisionId && policy === 'skip') {
          items.push({ label: file.rel, status: 'info', detail: 'kept existing file' })
          continue
        }
        if (file.collisionId && policy === 'backup-then-replace') {
          const aside = `${file.dest}.devmig-backup-test`
          await ctx.fs.rename(file.dest, aside)
          items.push({ label: `${file.rel} moved aside`, status: 'info', detail: aside })
        }
        await ctx.fs.copyFileAtomic(file.payloadPath, file.dest)
        restored.push(file.dest)
        items.push({ label: file.rel, status: 'ok', detail: file.dest })
      }
      return {
        providerId: id,
        projectId: project.id,
        status:
          restored.length === files.length ? 'ok' : restored.length > 0 ? 'partial' : 'skipped',
        items,
        warnings: [],
        ...(options.attention ? { attention: options.attention } : {}),
        state: { restored },
      }
    },

    async verify(input: ProviderVerifyInput, _ctx: VerifyContext): Promise<ProviderVerification> {
      calls.verify += 1
      const restored = (input.result.state?.restored as string[] | undefined) ?? []
      const checks: VerificationCheck[] = []
      for (const dest of restored) {
        let ok: boolean
        try {
          ok = (await fs.stat(dest)).isFile()
        } catch {
          ok = false
        }
        checks.push({
          id: `exists:${path.basename(dest)}`,
          label: `${path.basename(dest)} present`,
          status: ok ? 'pass' : 'fail',
          detail: dest,
        })
      }
      return { checks }
    },
  }
  return provider
}

// ---------------------------------------------------------------- fake user-wide provider

export interface GlobalProviderOptions {
  id?: string
  /** Also report a credential artifact (never selectable for backup). */
  withCredential?: boolean
  failGlobalScan?: Error
}

/**
 * User-wide provider: backs up `<claudeConfigDir>/settings.json` and restores it with add-only merge
 * semantics (merge | skip). scanProject always reports nothing.
 */
export function createGlobalProvider(options: GlobalProviderOptions = {}): MigrationProvider {
  const id = options.id ?? 'globalcfg'
  return {
    id,
    displayName: 'Fake global config',
    version: '0.0.1-test',
    schemaVersion: 2,
    supportsGlobal: true,

    detect(): Promise<ProviderDetection> {
      return Promise.resolve({ providerId: id, available: true, details: {}, notes: [] })
    },

    scanProject(project: ProjectDescriptor): Promise<ProviderScanResult> {
      return Promise.resolve({
        providerId: id,
        projectId: project.id,
        detected: false,
        artifacts: [],
        summary: [],
        warnings: [],
        estimatedBytes: 0,
      })
    },

    async scanGlobal(ctx: ScanContext): Promise<ProviderScanResult> {
      if (options.failGlobalScan) throw options.failGlobalScan
      const artifacts: ScannedArtifact[] = []
      const settings = path.join(ctx.claudeConfigDir, 'settings.json')
      try {
        const size = (await fs.stat(settings)).size
        artifacts.push({
          id: `${id}:settings`,
          providerId: id,
          scope: 'user',
          kind: 'file',
          label: 'User settings',
          sourcePath: settings,
          sizeBytes: size,
          sensitivity: 'safe',
          includedByDefault: true,
          selectable: true,
          reasons: [],
          meta: {},
        })
      } catch {
        // none
      }
      if (options.withCredential) {
        artifacts.push({
          id: `${id}:credentials`,
          providerId: id,
          scope: 'user',
          kind: 'file',
          label: 'OAuth credentials',
          sensitivity: 'credential',
          includedByDefault: false,
          selectable: false,
          reasons: ['Authentication credential; re-authenticate on the destination.'],
          meta: {},
        })
      }
      return {
        providerId: id,
        detected: artifacts.length > 0,
        artifacts,
        summary: [],
        warnings: [],
        estimatedBytes: artifacts.reduce((n, a) => n + (a.sizeBytes ?? 0), 0),
      }
    },

    async createBackupArtifacts(
      input: ProviderBackupInput,
      ctx: BackupContext,
    ): Promise<ProviderBackupOutput> {
      const artifacts: ManifestArtifact[] = []
      for (const artifact of input.artifacts) {
        const target = path.join(ctx.stagingDir, 'settings.json')
        await ctx.fs.copyFileAtomic(artifact.sourcePath as string, target)
        artifacts.push({
          id: artifact.id,
          providerId: id,
          kind: 'file',
          label: artifact.label,
          payloadPath: ctx.payloadPathFor('settings.json'),
          sizeBytes: (await fs.stat(target)).size,
          sensitivity: 'safe',
          ...(artifact.sourcePath ? { sourcePath: artifact.sourcePath } : {}),
          meta: {},
        })
      }
      return { artifacts, schemaVersion: 2, summary: { settings: artifacts.length } }
    },

    async planRestore(
      input: ProviderRestoreInput,
      ctx: RestorePlanningContext,
    ): Promise<ProviderRestorePlan> {
      const dest = path.join(ctx.claudeConfigDir, 'settings.json')
      const collisions: Collision[] = []
      let exists: boolean
      try {
        await fs.stat(dest)
        exists = true
      } catch {
        exists = false
      }
      if (exists) {
        collisions.push({
          id: 'settings',
          providerId: id,
          kind: 'json-entry-exists',
          path: dest,
          detail: 'settings.json exists; merge adds missing keys only',
          allowedPolicies: ['merge', 'skip'],
          policy: 'merge',
        })
      }
      const artifact = input.artifacts[0]
      return {
        providerId: id,
        steps: artifact
          ? [
              {
                id: 'settings',
                providerId: id,
                label: 'Restore user settings',
                destination: dest,
                artifactIds: [artifact.id],
              },
            ]
          : [],
        collisions,
        preflight: [],
        remap: { affected: [], safeRewriteCount: 0, warnings: [], unsupportedReferences: [] },
        warnings: [],
        state: {
          dest,
          payloadPath: artifact
            ? path.join(ctx.payloadRoot, ...artifact.payloadPath.split('/'))
            : null,
        },
      }
    },

    async restore(plan: ProviderRestorePlan, _input, ctx: RestoreContext) {
      const dest = plan.state.dest as string
      const payloadPath = plan.state.payloadPath as string | null
      if (!payloadPath) return { providerId: id, status: 'skipped', items: [], warnings: [] }
      const policy = ctx.collisionDecisions.settings
      const incoming = JSON.parse(await fs.readFile(payloadPath, 'utf8')) as Record<string, unknown>
      if (policy === 'skip') {
        return {
          providerId: id,
          status: 'skipped',
          items: [{ label: 'settings.json kept', status: 'info' }],
          warnings: [],
        }
      }
      let merged = incoming
      if (policy === 'merge') {
        const existing = JSON.parse(await fs.readFile(dest, 'utf8')) as Record<string, unknown>
        merged = { ...incoming, ...existing }
      }
      await ctx.fs.writeFileAtomic(dest, JSON.stringify(merged, null, 2))
      return {
        providerId: id,
        status: 'ok',
        items: [{ label: 'settings.json restored', status: 'ok', detail: dest }],
        warnings: [],
        state: { dest },
      }
    },

    async verify(input: ProviderVerifyInput): Promise<ProviderVerification> {
      const dest = input.result.state?.dest as string | undefined
      if (!dest) return { checks: [] }
      let ok: boolean
      try {
        JSON.parse(await fs.readFile(dest, 'utf8'))
        ok = true
      } catch {
        ok = false
      }
      return {
        checks: [
          {
            id: 'settings-json',
            label: 'settings.json is valid JSON',
            status: ok ? 'pass' : 'fail',
          },
        ],
      }
    },
  }
}

// ---------------------------------------------------------------- misc helpers

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
  }
}

export async function readJson<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort()
  } catch {
    return []
  }
}
