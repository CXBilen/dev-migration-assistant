import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  RestorePlan as RestorePlanSchema,
  RestoreResult as RestoreResultSchema,
  type BackupResult,
  type Manifest,
  type RestorePlan,
  type RestoreResult,
  type ScanSession,
} from '@devmig/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DefaultBackupEngine } from '../backup/backup-engine'
import { DefaultMigrationPlanner, defaultSelection } from '../migration/planner'
import { ProviderRegistry } from '../providers/registry'
import { DefaultProjectScanner } from '../scan/project-scanner'
import {
  createFileProvider,
  createGlobalProvider,
  listDir,
  makeJobHarness,
  makeTempRoot,
  makeTestEnv,
  readJson,
  writeFiles,
  type FakeFileProvider,
  type FileProviderOptions,
  type JobHarness,
  type TempRoot,
  type TestEnv,
} from '../testing/engine-fixtures'
import { FakeArchiveAdapter } from '../testing/fake-archive-adapter'
import { DefaultRestoreEngine, HOME_MAPPING_PROJECT_ID } from './restore-engine'

interface MachineA {
  test: TestEnv
  project: string
  projectId: string
  backupPath: string
  manifest: Manifest
  artifactIds: string[]
}

interface MachineB {
  test: TestEnv
  harness: JobHarness
  workDir: string
  engine: DefaultRestoreEngine
  files: FakeFileProvider
  registry: ProviderRegistry
  newProject: string
}

describe('DefaultRestoreEngine (integration, fake providers + fake archive)', () => {
  let tmp: TempRoot
  let archive: FakeArchiveAdapter
  let a: MachineA

  async function backupOnMachineA(
    adapter: FakeArchiveAdapter = archive,
    name = 'app',
  ): Promise<MachineA> {
    const root = path.join(tmp.root, 'machine-a')
    const test = await makeTestEnv(root)
    const harness = makeJobHarness(test.env.logger)
    const project = path.join(test.homeDir, 'Projects', 'app')
    await writeFiles(project, {
      'notes.txt': 'from A',
      'ideas.txt': 'idea',
      'settings.json': '{"editor":"vim"}',
    })
    await writeFiles(test.claudeConfigDir, { 'settings.json': '{"theme":"dark","fromA":true}' })
    const registry = new ProviderRegistry()
      .register(createFileProvider())
      .register(createGlobalProvider())
    const scanner = new DefaultProjectScanner({ env: test.env, registry })
    const engine = new DefaultBackupEngine({
      env: test.env,
      registry,
      scanner,
      planner: new DefaultMigrationPlanner(),
      archive: adapter,
      appVersion: '0.1.0-test',
      workDir: path.join(root, 'work'),
    })
    const scan = await harness.run<ScanSession>('scan', (ctx) =>
      scanner.scan([project], { includeGlobal: true }, ctx),
    )
    const backupPath = path.join(root, `${name}.devbackup`)
    const result = await harness.run<BackupResult>('backup', (ctx) =>
      engine.run(
        {
          scanId: scan.id,
          selectedArtifactIds: defaultSelection(scan),
          outputPath: backupPath,
          password: 'correct horse',
          label: 'A',
        },
        ctx,
      ),
    )
    const artifactIds = [
      ...result.manifest.projects.flatMap((p) =>
        p.providers.flatMap((s) => s.artifacts.map((x) => x.id)),
      ),
      ...result.manifest.global.flatMap((s) => s.artifacts.map((x) => x.id)),
    ]
    return {
      test,
      project,
      projectId: scan.projects[0]!.project.id,
      backupPath,
      manifest: result.manifest,
      artifactIds,
    }
  }

  async function machineB(
    options: {
      files?: FileProviderOptions
      adapter?: FakeArchiveAdapter
      extraProviders?: boolean
    } = {},
  ): Promise<MachineB> {
    const root = path.join(tmp.root, 'machine-b')
    const test = await makeTestEnv(root)
    const harness = makeJobHarness(test.env.logger)
    const files = createFileProvider(options.files)
    const registry = new ProviderRegistry().register(files).register(createGlobalProvider())
    const workDir = path.join(root, 'work')
    const engine = new DefaultRestoreEngine({
      env: test.env,
      registry,
      archive: options.adapter ?? archive,
      workDir,
    })
    return {
      test,
      harness,
      workDir,
      engine,
      files,
      registry,
      newProject: path.join(test.homeDir, 'Code', 'app'),
    }
  }

  function planRequest(
    b: MachineB,
    over: Partial<Parameters<DefaultRestoreEngine['plan']>[0]> = {},
  ) {
    return {
      backupPath: a.backupPath,
      password: 'correct horse',
      mappings: [{ projectId: a.projectId, oldPath: a.project, newPath: b.newProject }],
      selectedArtifactIds: a.artifactIds,
      options: { defaultCollisionPolicy: 'skip' as const, includeGlobal: true },
      ...over,
    }
  }

  beforeEach(async () => {
    tmp = await makeTempRoot('devmig-restore-')
    archive = new FakeArchiveAdapter()
    a = await backupOnMachineA()
  })
  afterEach(async () => {
    await tmp.cleanup()
  })

  it('reads the header and inspects the manifest; wrong passwords fail closed', async () => {
    const b = await machineB()
    const header = await b.engine.readHeader(a.backupPath)
    expect(header).toMatchObject({
      path: a.backupPath,
      formatVersion: 1,
      supported: true,
      kdf: { algorithm: 'argon2id' },
      cipher: 'aes-256-gcm',
    })
    expect(header.sizeBytes).toBeGreaterThan(0)
    const inspection = await b.engine.inspect(a.backupPath, 'correct horse')
    expect(inspection.manifest.id).toBe(a.manifest.id)
    expect(inspection.formatVersion).toBe(1)
    await expect(b.engine.inspect(a.backupPath, 'wrong password')).rejects.toMatchObject({
      code: 'ARCHIVE_AUTH_FAILED',
    })
    await expect(
      b.engine.readHeader(path.join(tmp.root, 'missing.devbackup')),
    ).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' })
    await expect(b.engine.inspect('relative.devbackup', 'x')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('previews the remap without writing anything and reuses the extracted staging for planning', async () => {
    const b = await machineB()
    const report = await b.engine.previewRemap(a.backupPath, 'correct horse', [
      { projectId: a.projectId, oldPath: a.project, newPath: b.newProject },
    ])
    expect(report.mappings.map((m) => [m.projectId, m.oldPath, m.newPath])).toEqual([
      [a.projectId, a.project, b.newProject],
      [HOME_MAPPING_PROJECT_ID, a.test.homeDir, b.test.homeDir],
    ])
    expect(report.affected).toEqual([{ providerId: 'files', label: 'file references', count: 3 }])
    expect(report.safeRewriteCount).toBe(3)
    expect(report.unsupportedReferences).toEqual([])
    expect(await listDir(b.newProject)).toEqual([])
    expect(b.files.calls.plan).toBe(1) // dry-run planning stands in for remapPaths

    await b.harness.run<RestorePlan>('restore-plan', (ctx) => b.engine.plan(planRequest(b), ctx))
    expect(archive.calls.filter((c) => c.op === 'extract')).toHaveLength(1) // preview + plan share one extraction
  })

  it('plans a restore to a new location: phases, steps, preflight, remap report', async () => {
    const b = await machineB()
    const plan = await b.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b.engine.plan(planRequest(b), ctx),
    )
    expect(RestorePlanSchema.parse(plan)).toEqual(plan)
    expect(b.engine.getPlan(plan.id)).toEqual(plan)
    expect(plan.backupPath).toBe(a.backupPath)
    expect(plan.canProceed).toBe(true)
    expect(plan.projects).toHaveLength(1)
    const project = plan.projects[0]!
    expect(project).toMatchObject({
      projectId: a.projectId,
      name: 'app',
      oldPath: a.project,
      newPath: b.newProject,
      pathChanged: true,
      collisions: [],
    })
    expect(project.steps.map((s) => s.id).sort()).toEqual([
      `files@${a.projectId}:ideas.txt`,
      `files@${a.projectId}:notes.txt`,
      `files@${a.projectId}:settings.json`,
    ])
    expect(
      project.steps.every((s) => s.providerId === 'files' && s.projectId === a.projectId),
    ).toBe(true)
    expect(plan.globalSteps.map((s) => s.id)).toEqual(['globalcfg@global:settings'])
    expect(plan.globalCollisions).toEqual([])
    const preflightIds = plan.preflight.map((c) => c.id)
    expect(preflightIds).toContain('engine:workdir')
    expect(preflightIds).toContain(`engine:dest:${a.projectId}`)
    expect(preflightIds).toContain(`engine:space:${a.projectId}`)
    expect(preflightIds).toContain('engine:claude-config-dir')
    expect(preflightIds).toContain(`files@${a.projectId}:ready`)
    expect(plan.preflight.find((c) => c.id === `engine:dest:${a.projectId}`)).toMatchObject({
      status: 'warn',
      blocking: false,
    })
    expect(plan.preflight.every((c) => c.status !== 'fail')).toBe(true)
    expect(plan.remap.safeRewriteCount).toBe(3)
    expect(plan.remap.mappings.some((m) => m.projectId === HOME_MAPPING_PROJECT_ID)).toBe(true)
    const phases = [...new Set(b.harness.events.map((e) => e.phase))]
    for (const p of ['INSPECT', 'DECRYPT', 'VALIDATE', 'MAP_PATHS', 'PREFLIGHT', 'COMPLETE'])
      expect(phases).toContain(p)
    expect(phases.indexOf('DECRYPT')).toBeLessThan(phases.indexOf('MAP_PATHS'))
    expect(phases.indexOf('MAP_PATHS')).toBeLessThan(phases.indexOf('PREFLIGHT'))
    // Nothing written to destinations while planning; the payload sits in private 0700 staging.
    await expect(fs.stat(b.newProject)).rejects.toThrow()
    const staging = await listDir(b.workDir)
    expect(staging.filter((d) => d.startsWith('restore-'))).toHaveLength(1)
    expect((await fs.stat(path.join(b.workDir, staging[0]!))).mode & 0o777).toBe(0o700)
    expect(b.files.calls.lastPlanCtx?.mapPath(path.join(a.project, 'x'))).toMatchObject({
      newPath: path.join(b.newProject, 'x'),
      changed: true,
    })
    expect(
      b.files.calls.lastPlanCtx?.mapPath(path.join(a.test.homeDir, '.claude', 'y')).newPath,
    ).toBe(path.join(b.test.homeDir, '.claude', 'y'))
  })

  it('reports collisions with non-destructive defaults and never downgrades a provider merge default', async () => {
    const b = await machineB()
    await writeFiles(b.newProject, { 'notes.txt': 'already here' })
    await writeFiles(b.test.claudeConfigDir, { 'settings.json': '{"theme":"light"}' })
    const plan = await b.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b.engine.plan(
        planRequest(b, { options: { defaultCollisionPolicy: 'skip', includeGlobal: true } }),
        ctx,
      ),
    )
    expect(plan.projects[0]!.collisions).toEqual([
      expect.objectContaining({
        id: `files@${a.projectId}:notes.txt`,
        providerId: 'files',
        projectId: a.projectId,
        kind: 'file-exists',
        path: path.join(b.newProject, 'notes.txt'),
        allowedPolicies: ['skip', 'backup-then-replace'],
        policy: 'skip',
      }),
    ])
    expect(plan.globalCollisions).toEqual([
      expect.objectContaining({
        id: 'globalcfg@global:settings',
        kind: 'json-entry-exists',
        policy: 'merge',
      }),
    ])
    expect(plan.preflight.find((c) => c.id === `engine:dest:${a.projectId}`)?.label).toContain(
      'destination exists',
    )
    expect(plan.canProceed).toBe(true)
  })

  it('executes an approved plan with collision decisions, verifies, reports and cleans staging', async () => {
    const b = await machineB({
      files: {
        attention: [{ id: 'reauth', level: 'warn', title: 'Sign in again', action: 'reauth' }],
      },
    })
    await writeFiles(b.newProject, { 'notes.txt': 'already here' })
    await writeFiles(b.test.claudeConfigDir, { 'settings.json': '{"theme":"light"}' })
    const plan = await b.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b.engine.plan(planRequest(b), ctx),
    )
    const collisionId = plan.projects[0]!.collisions[0]!.id

    await expect(
      b.harness.run<RestoreResult>('restore', (ctx) =>
        b.engine.execute({ planId: plan.id, collisionDecisions: { [collisionId]: 'merge' } }, ctx),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      b.harness.run<RestoreResult>('restore', (ctx) =>
        b.engine.execute({ planId: 'plan_missing', collisionDecisions: {} }, ctx),
      ),
    ).rejects.toMatchObject({ code: 'RESTORE_PLAN_REJECTED' })

    const result = await b.harness.run<RestoreResult>('restore', (ctx) =>
      b.engine.execute(
        { planId: plan.id, collisionDecisions: { [collisionId]: 'backup-then-replace' } },
        ctx,
      ),
    )
    expect(RestoreResultSchema.parse(result)).toEqual(result)
    expect(result.planId).toBe(plan.id)
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0]).toMatchObject({
      projectId: a.projectId,
      name: 'app',
      newPath: b.newProject,
    })
    expect(result.projects[0]!.providers[0]).toMatchObject({
      providerId: 'files',
      projectId: a.projectId,
      status: 'ok',
    })
    expect(result.global[0]).toMatchObject({ providerId: 'globalcfg', status: 'ok' })
    expect(result.verification.ok).toBe(true)
    expect(result.verification.checks.map((c) => c.id).sort()).toEqual([
      `files@${a.projectId}:exists:ideas.txt`,
      `files@${a.projectId}:exists:notes.txt`,
      `files@${a.projectId}:exists:settings.json`,
      'globalcfg@global:settings-json',
    ])
    expect(result.verification.checks.every((c) => c.status === 'pass')).toBe(true)
    expect(result.attention).toEqual([
      expect.objectContaining({
        id: `files@${a.projectId}:reauth`,
        providerId: 'files',
        action: 'reauth',
      }),
    ])

    // Files landed at the mapped destination; the collision was moved aside, the global file merged add-only.
    expect(await fs.readFile(path.join(b.newProject, 'notes.txt'), 'utf8')).toBe('from A')
    expect(await fs.readFile(path.join(b.newProject, 'notes.txt.devmig-backup-test'), 'utf8')).toBe(
      'already here',
    )
    expect(await fs.readFile(path.join(b.newProject, 'ideas.txt'), 'utf8')).toBe('idea')
    expect(await readJson(path.join(b.newProject, 'settings.json'))).toEqual({
      fragment: { editor: 'vim' },
    })
    expect(await readJson(path.join(b.test.claudeConfigDir, 'settings.json'))).toEqual({
      theme: 'light',
      fromA: true,
    })
    // Machine A untouched.
    expect(await fs.readFile(path.join(a.project, 'notes.txt'), 'utf8')).toBe('from A')

    // Phases: provider phase for an unknown provider id is RESTORE_<ID>; then VERIFY and REPORT.
    const phases = [...new Set(b.harness.events.map((e) => e.phase))]
    expect(phases).toContain('STAGE')
    expect(phases).toContain('RESTORE_FILES')
    expect(phases).toContain('RESTORE_GLOBALCFG')
    expect(phases.indexOf('RESTORE_FILES')).toBeLessThan(phases.indexOf('VERIFY'))
    expect(phases.indexOf('VERIFY')).toBeLessThan(phases.indexOf('REPORT'))
    const unitItem = b.harness.events.find(
      (e) => e.item?.id === `files@${a.projectId}` && e.item.status === 'done',
    )
    expect(unitItem?.projectId).toBe(a.projectId)

    // Staging removed after execution; the plan cannot run twice.
    expect((await listDir(b.workDir)).filter((d) => d.startsWith('restore-'))).toEqual([])
    await expect(
      b.harness.run<RestoreResult>('restore', (ctx) =>
        b.engine.execute({ planId: plan.id, collisionDecisions: {} }, ctx),
      ),
    ).rejects.toMatchObject({ code: 'RESTORE_PLAN_REJECTED' })
    await b.engine.cleanup()
    await b.engine.dispose()
  })

  it('confines providers to the approved roots and keeps going when one fails', async () => {
    const b = await machineB({ files: { escapeOnRestore: true } })
    const plan = await b.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b.engine.plan(planRequest(b), ctx),
    )
    const result = await b.harness.run<RestoreResult>('restore', (ctx) =>
      b.engine.execute({ planId: plan.id, collisionDecisions: {} }, ctx),
    )
    const filesOutcome = result.projects[0]!.providers[0]!
    expect(filesOutcome.status).toBe('failed')
    expect(filesOutcome.warnings[0]).toContain('outside the approved destination')
    expect(result.global[0]?.status).toBe('ok')
    expect(result.verification.ok).toBe(false)
    expect(
      result.verification.checks.find((c) => c.id === `files@${a.projectId}:restore`),
    ).toMatchObject({ status: 'fail' })
    await expect(fs.stat(path.join(b.test.homeDir, 'Code', 'escaped.txt'))).rejects.toThrow()
    expect(await readJson(path.join(b.test.claudeConfigDir, 'settings.json'))).toEqual({
      theme: 'dark',
      fromA: true,
    })
    expect(b.files.calls.lastRestoreCtx?.fs.roots).toEqual([
      b.newProject,
      b.test.claudeConfigDir,
      b.test.claudeJsonPath,
    ])
    expect(
      b.harness.events.some((e) => e.item?.status === 'failed' && e.providerId === 'files'),
    ).toBe(true)
  })

  it('adds announced aside paths to the roots only for backup-then-replace decisions', async () => {
    const b = await machineB({ files: { announceAsidePaths: true } })
    await writeFiles(b.newProject, { 'notes.txt': 'already here' })
    const plan = await b.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b.engine.plan(planRequest(b), ctx),
    )
    const collisionId = plan.projects[0]!.collisions[0]!.id
    await b.harness.run<RestoreResult>('restore', (ctx) =>
      b.engine.execute({ planId: plan.id, collisionDecisions: {} }, ctx),
    )
    expect(b.files.calls.lastRestoreCtx?.fs.roots).toEqual([
      b.newProject,
      b.test.claudeConfigDir,
      b.test.claudeJsonPath,
    ])

    const plan2 = await b.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b.engine.plan(planRequest(b), ctx),
    )
    await b.harness.run<RestoreResult>('restore', (ctx) =>
      b.engine.execute(
        { planId: plan2.id, collisionDecisions: { [collisionId]: 'backup-then-replace' } },
        ctx,
      ),
    )
    expect(b.files.calls.lastRestoreCtx?.fs.roots).toEqual([
      b.newProject,
      b.test.claudeConfigDir,
      b.test.claudeJsonPath,
      `${b.newProject}.devmig-backup-test`,
    ])
  })

  it('skips unknown providers with a warning and honours includeGlobal=false', async () => {
    const b = await machineB()
    await archive.patchManifest(a.backupPath, (m) => ({
      ...m,
      global: m.global.map((s) => ({ ...s, providerId: 'ghost' })),
      providers: { ...m.providers, ghost: 1 },
    }))
    const plan = await b.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b.engine.plan(planRequest(b), ctx),
    )
    expect(plan.canProceed).toBe(true)
    expect(plan.globalSteps).toEqual([])
    expect(plan.warnings.some((w) => w.includes('"ghost" is not available'))).toBe(true)

    const b2 = await machineB()
    const plan2 = await b2.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b2.engine.plan(
        planRequest(b2, { options: { defaultCollisionPolicy: 'skip', includeGlobal: false } }),
        ctx,
      ),
    )
    expect(plan2.globalSteps).toEqual([])
    expect(plan2.warnings.some((w) => w.includes('user-wide'))).toBe(true)
  })

  it('rejects unsupported container versions, tampered payloads and empty selections', async () => {
    const newer = new FakeArchiveAdapter({ formatVersion: 2 })
    const a2 = await backupOnMachineA(newer, 'newer')
    const b = await machineB()
    await expect(
      b.harness.run<RestorePlan>('restore-plan', (ctx) =>
        b.engine.plan({ ...planRequest(b), backupPath: a2.backupPath }, ctx),
      ),
    ).rejects.toMatchObject({ code: 'ARCHIVE_UNSUPPORTED_VERSION' })

    await expect(
      b.harness.run<RestorePlan>('restore-plan', (ctx) =>
        b.engine.plan({ ...planRequest(b), selectedArtifactIds: ['nope'] }, ctx),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      b.harness.run<RestorePlan>('restore-plan', (ctx) =>
        b.engine.plan({ ...planRequest(b), password: 'wrong password' }, ctx),
      ),
    ).rejects.toMatchObject({ code: 'ARCHIVE_AUTH_FAILED' })

    const raw = JSON.parse(await fs.readFile(a.backupPath, 'utf8')) as {
      entries: { path: string; dataBase64: string }[]
    }
    const entry = raw.entries.find((e) => e.path.endsWith('notes.txt'))!
    entry.dataBase64 = Buffer.from('tampered').toString('base64')
    await fs.writeFile(a.backupPath, JSON.stringify(raw))
    await expect(
      b.harness.run<RestorePlan>('restore-plan', (ctx) => b.engine.plan(planRequest(b), ctx)),
    ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
    // The failed extraction left nothing behind; the earlier (successful) extraction is cached until cleanup().
    expect((await listDir(b.workDir)).filter((d) => d.startsWith('restore-'))).toHaveLength(1)
    await b.engine.cleanup()
    expect((await listDir(b.workDir)).filter((d) => d.startsWith('restore-'))).toEqual([])
  })

  it('refuses dangerous destinations and duplicate targets', async () => {
    const b = await machineB()
    await expect(
      b.harness.run<RestorePlan>('restore-plan', (ctx) =>
        b.engine.plan(
          planRequest(b, {
            mappings: [{ projectId: a.projectId, oldPath: a.project, newPath: b.test.homeDir }],
          }),
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      b.harness.run<RestorePlan>('restore-plan', (ctx) =>
        b.engine.plan(
          planRequest(b, {
            mappings: [{ projectId: a.projectId, oldPath: a.project, newPath: 'relative/app' }],
          }),
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const plan = await b.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b.engine.plan(planRequest(b, { mappings: [] }), ctx),
    )
    expect(plan.projects[0]).toMatchObject({ newPath: a.project, pathChanged: false })
    expect(plan.warnings.some((w) => w.includes('No destination chosen'))).toBe(true)
  })

  it('verify() streams through the backup', async () => {
    const b = await machineB()
    const result = await b.harness.run('verify', (ctx) =>
      b.engine.verify(a.backupPath, 'correct horse', ctx),
    )
    expect(result.ok).toBe(true)
    expect(result.entries).toBeGreaterThan(3)
    expect(result.bytes).toBeGreaterThan(0)
    await expect(
      b.harness.run('verify', (ctx) => b.engine.verify(a.backupPath, 'wrong password', ctx)),
    ).rejects.toMatchObject({ code: 'ARCHIVE_AUTH_FAILED' })
  })

  it('stops when cancelled during execution and marks the plan failed', async () => {
    const controller = new AbortController()
    const b = await machineB()
    const plan = await b.harness.run<RestorePlan>('restore-plan', (ctx) =>
      b.engine.plan(planRequest(b), ctx),
    )
    const originalRestore = b.files.restore.bind(b.files)
    b.files.restore = async (p, input, ctx) => {
      controller.abort()
      return originalRestore(p, input, ctx)
    }
    const snapshot = b.harness.jobs.start('restore', (ctx) => {
      controller.signal.addEventListener('abort', () => b.harness.jobs.cancel(snapshot.id), {
        once: true,
      })
      return b.engine.execute({ planId: plan.id, collisionDecisions: {} }, ctx)
    })
    const final = await b.harness.jobs.wait(snapshot.id)
    expect(final.status).toBe('cancelled')
    await expect(fs.stat(path.join(b.test.claudeConfigDir, 'settings.json'))).rejects.toThrow()
    expect(b.engine.getPlan(plan.id)).toBeDefined()
    await expect(
      b.harness.run<RestoreResult>('restore', (ctx) =>
        b.engine.execute({ planId: plan.id, collisionDecisions: {} }, ctx),
      ),
    ).rejects.toMatchObject({ code: 'RESTORE_PLAN_REJECTED' })
  })
})
