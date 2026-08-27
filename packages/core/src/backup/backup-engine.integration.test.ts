import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Manifest as ManifestSchema, type BackupResult, type ScanSession } from '@devmig/model'
import { walkFiles } from '@devmig/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  writeFiles,
  type FakeFileProvider,
  type JobHarness,
  type TempRoot,
  type TestEnv,
} from '../testing/engine-fixtures'
import { FakeArchiveAdapter } from '../testing/fake-archive-adapter'
import { DefaultBackupEngine } from './backup-engine'

/** `expect.stringContaining` typed as string so it can sit inside typed matcher objects. */
const containing = (text: string): string => expect.stringContaining(text) as string

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  const entries: string[] = []
  for await (const e of walkFiles(root)) entries.push(`${e.relativePath}:${e.sizeBytes}`)
  for (const e of entries.sort()) hash.update(e)
  return hash.digest('hex')
}

describe('DefaultBackupEngine (integration, fake providers + fake archive)', () => {
  let tmp: TempRoot
  let test: TestEnv
  let harness: JobHarness
  let workDir: string
  let outDir: string
  let project: string
  let files: FakeFileProvider
  let archive: FakeArchiveAdapter

  async function setup(
    options: {
      files?: FakeFileProvider
      archive?: FakeArchiveAdapter
    } = {},
  ): Promise<{
    engine: DefaultBackupEngine
    scanner: DefaultProjectScanner
    scan: ScanSession
    registry: ProviderRegistry
  }> {
    files =
      options.files ??
      createFileProvider({
        summary: { sessionCount: 3, worktreeCount: 2 },
        restoreHints: { filesEncoding: 'plain' },
      })
    archive = options.archive ?? new FakeArchiveAdapter()
    const registry = new ProviderRegistry().register(files).register(createGlobalProvider())
    const scanner = new DefaultProjectScanner({ env: test.env, registry })
    const engine = new DefaultBackupEngine({
      env: test.env,
      registry,
      scanner,
      planner: new DefaultMigrationPlanner(),
      archive,
      appVersion: '0.1.0-test',
      workDir,
    })
    const scan = await harness.run('scan', (ctx) =>
      scanner.scan([project], { includeGlobal: true }, ctx),
    )
    return { engine, scanner, scan, registry }
  }

  beforeEach(async () => {
    tmp = await makeTempRoot('devmig-backup-')
    test = await makeTestEnv(tmp.root)
    harness = makeJobHarness(test.env.logger)
    workDir = path.join(tmp.root, 'work')
    outDir = path.join(tmp.root, 'out')
    await fs.mkdir(outDir)
    project = path.join(test.homeDir, 'Projects', 'app')
    await writeFiles(project, {
      'notes.txt': 'remember the milk',
      'ideas.txt': 'idea',
      'settings.json': '{"editor":"vim"}',
      'README.md': '# app',
    })
    await writeFiles(test.claudeConfigDir, { 'settings.json': '{"theme":"dark"}' })
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  it('produces a verified backup with the expected manifest, payload layout and progress', async () => {
    const { engine, scan } = await setup()
    const before = await treeDigest(test.homeDir)
    const outputPath = path.join(outDir, 'app.devbackup')
    const selected = defaultSelection(scan)
    const result = await harness.run<BackupResult>('backup', (ctx) =>
      engine.run(
        {
          scanId: scan.id,
          selectedArtifactIds: selected,
          outputPath,
          password: 'correct horse',
          label: 'My backup',
        },
        ctx,
      ),
    )

    // BackupResult
    expect(result.outputPath).toBe(outputPath)
    expect(result.verified).toBe(true)
    expect(result.sizeBytes).toBe((await fs.stat(outputPath)).size)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.warnings).toEqual([])

    // Manifest
    const manifest = ManifestSchema.parse(result.manifest)
    const projectId = scan.projects[0]!.project.id
    expect(manifest).toMatchObject({
      format: 'devbackup',
      formatVersion: 1,
      label: 'My backup',
      appVersion: '0.1.0-test',
      providers: { files: 1, globalcfg: 2 },
      restoreHints: { filesEncoding: 'plain' },
    })
    expect(manifest.machine.homeDir).toBe(test.homeDir)
    expect(manifest.machine.machineLabel).toBeNull()
    expect(manifest.projects).toHaveLength(1)
    expect(manifest.projects[0]).toMatchObject({
      id: projectId,
      name: 'app',
      canonicalPath: project,
      originalPath: project,
    })
    const section = manifest.projects[0]!.providers[0]!
    expect(section.providerId).toBe('files')
    expect(section.schemaVersion).toBe(1)
    expect(section.summary).toMatchObject({ fileCount: 3, sessionCount: 3, worktreeCount: 2 })
    expect(section.artifacts.map((a) => a.payloadPath).sort()).toEqual([
      `projects/${projectId}/files/files/ideas.txt`,
      `projects/${projectId}/files/files/notes.txt`,
      `projects/${projectId}/files/fragments/settings.json`,
    ])
    expect(section.artifacts.every((a) => a.id.startsWith('files:'))).toBe(true)
    expect(manifest.global).toHaveLength(1)
    expect(manifest.global[0]!.artifacts[0]!.payloadPath).toBe('global/globalcfg/settings.json')
    const payloadBytes = [...section.artifacts, ...manifest.global[0]!.artifacts].reduce(
      (n, a) => n + a.sizeBytes,
      0,
    )
    expect(manifest.stats).toEqual({
      projectCount: 1,
      artifactCount: 4,
      payloadBytes,
      claudeSessionCount: 3,
      worktreeCount: 2,
    })

    // Payload layout inside the container
    const entries = await archive.listEntries(outputPath)
    expect(entries[0]).toBe('manifest.json')
    expect(entries.at(-1)).toBe('checksums.json')
    expect(entries).toContain('machine.json')
    expect(entries).toContain(`projects/${projectId}/files/files/notes.txt`)
    expect(entries).toContain('global/globalcfg/settings.json')
    expect(
      (
        await archive.readEntry(outputPath, `projects/${projectId}/files/files/notes.txt`)
      )?.toString(),
    ).toBe('remember the milk')
    const storedManifest = JSON.parse(
      (await archive.readEntry(outputPath, 'manifest.json'))!.toString(),
    ) as { id: string }
    expect(storedManifest.id).toBe(manifest.id)
    expect(archive.calls.map((c) => c.op)).toEqual(['create', 'verify'])

    // Staging cleaned, sources untouched
    expect(await listDir(workDir)).toEqual([])
    expect(await treeDigest(test.homeDir)).toBe(before)

    // Phases + progress conventions
    const phases = [
      ...new Set(
        harness.events
          .filter((e) => e.jobId !== harness.events[0]?.jobId || true)
          .map((e) => e.phase),
      ),
    ]
    for (const p of ['PLANNING', 'COLLECTING', 'PACKING', 'ENCRYPTING', 'VERIFYING', 'COMPLETE'])
      expect(phases).toContain(p)
    expect(phases.indexOf('COLLECTING')).toBeLessThan(phases.indexOf('PACKING'))
    expect(phases.indexOf('ENCRYPTING')).toBeLessThan(phases.indexOf('VERIFYING'))
    const items = harness.events.filter((e) => e.item)
    const providerItem = items.find(
      (e) => e.item?.id === `${projectId}:files` && e.item.status === 'done',
    )
    expect(providerItem?.projectId).toBe(projectId)
    expect(providerItem?.providerId).toBe('files')
    for (const id of ['pack', 'encrypt', 'verify']) {
      const done = items.find((e) => e.item?.id === id && e.item.status === 'done')
      expect(done).toBeDefined()
      expect(done?.projectId).toBeUndefined()
    }
    expect(items.some((e) => e.item?.id === 'global:globalcfg' && e.item.status === 'done')).toBe(
      true,
    )
  })

  it('cancelling mid-collect leaves no output and no staging directory', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = createFileProvider({
      beforeBackup: async (_input, ctx) => {
        release?.()
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve()
          else ctx.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    })
    const { engine, scan } = await setup({ files: slow })
    const outputPath = path.join(outDir, 'cancelled.devbackup')
    const snapshot = harness.jobs.start('backup', (ctx) =>
      engine.run(
        {
          scanId: scan.id,
          selectedArtifactIds: defaultSelection(scan),
          outputPath,
          password: 'correct horse',
          label: 'x',
        },
        ctx,
      ),
    )
    await blocked
    expect(await listDir(workDir)).not.toEqual([]) // staging exists while collecting
    harness.jobs.cancel(snapshot.id)
    const final = await harness.jobs.wait(snapshot.id)
    expect(final.status).toBe('cancelled')
    expect(final.error?.code).toBe('CANCELLED')
    await expect(fs.stat(outputPath)).rejects.toThrow()
    expect(await listDir(workDir)).toEqual([])
    expect(archive.calls).toEqual([])
  })

  it('validates the request before touching anything', async () => {
    const { engine, scan } = await setup()
    const selected = defaultSelection(scan)
    const run = (req: { scanId?: string; outputPath: string; selectedArtifactIds?: string[] }) =>
      harness.run<BackupResult>('backup', (ctx) =>
        engine.run(
          {
            scanId: req.scanId ?? scan.id,
            selectedArtifactIds: req.selectedArtifactIds ?? selected,
            outputPath: req.outputPath,
            password: 'correct horse',
            label: 'x',
          },
          ctx,
        ),
      )
    await expect(
      run({ scanId: 'scan_missing', outputPath: path.join(outDir, 'a.devbackup') }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    const existing = path.join(outDir, 'exists.devbackup')
    await fs.writeFile(existing, 'x')
    await expect(run({ outputPath: existing })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      hint: containing('never overwritten'),
    })
    expect(await fs.readFile(existing, 'utf8')).toBe('x')
    await expect(
      run({ outputPath: path.join(tmp.root, 'missing-dir', 'a.devbackup') }),
    ).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' })
    await expect(run({ outputPath: 'relative.devbackup' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(
      run({ outputPath: path.join(outDir, 'b.devbackup'), selectedArtifactIds: ['nope'] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      harness.run<BackupResult>('backup', (ctx) =>
        engine.run(
          {
            scanId: scan.id,
            selectedArtifactIds: selected,
            outputPath: path.join(outDir, 'c.devbackup'),
            password: 'short',
            label: 'x',
          },
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await listDir(workDir)).toEqual([])
    expect(await listDir(outDir)).toEqual(['exists.devbackup'])
  })

  it('refuses provider writes outside the staging dir and cleans up', async () => {
    const escaping = createFileProvider({ escapeOnBackup: true })
    const { engine, scan } = await setup({ files: escaping })
    const outputPath = path.join(outDir, 'escape.devbackup')
    await expect(
      harness.run<BackupResult>('backup', (ctx) =>
        engine.run(
          {
            scanId: scan.id,
            selectedArtifactIds: defaultSelection(scan),
            outputPath,
            password: 'correct horse',
            label: 'x',
          },
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' })
    await expect(fs.stat(outputPath)).rejects.toThrow()
    expect(await listDir(workDir)).toEqual([])
    expect(harness.events.some((e) => e.item?.status === 'failed' && e.level === 'error')).toBe(
      true,
    )
  })

  it('rejects provider output that points outside its payload section', async () => {
    const lying = createFileProvider()
    const original = lying.createBackupArtifacts.bind(lying)
    lying.createBackupArtifacts = async (input, ctx) => {
      const out = await original(input, ctx)
      out.artifacts[0]!.payloadPath = 'manifest.json'
      return out
    }
    const { engine, scan } = await setup({ files: lying })
    await expect(
      harness.run<BackupResult>('backup', (ctx) =>
        engine.run(
          {
            scanId: scan.id,
            selectedArtifactIds: defaultSelection(scan),
            outputPath: path.join(outDir, 'lying.devbackup'),
            password: 'correct horse',
            label: 'x',
          },
          ctx,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
      message: containing('outside the provider staging dir'),
    })
    expect(await listDir(workDir)).toEqual([])
  })

  it('removes a partial output file when packing fails', async () => {
    const failing = new FakeArchiveAdapter({
      beforeCreate: async (opts) => {
        await fs.writeFile(opts.outputPath, 'partial')
        throw new Error('disk exploded during packing')
      },
    })
    const { engine, scan } = await setup({ archive: failing })
    const outputPath = path.join(outDir, 'partial.devbackup')
    await expect(
      harness.run<BackupResult>('backup', (ctx) =>
        engine.run(
          {
            scanId: scan.id,
            selectedArtifactIds: defaultSelection(scan),
            outputPath,
            password: 'correct horse',
            label: 'x',
          },
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ message: containing('disk exploded') })
    await expect(fs.stat(outputPath)).rejects.toThrow()
    expect(await listDir(workDir)).toEqual([])
  })

  it('includes explicitly selected sensitive items and reports them', async () => {
    await writeFiles(project, { 'secret-notes.txt': 'TOKEN=abc' })
    const { engine, scan } = await setup()
    const all = scan.projects[0]!.providers[0]!.artifacts.map((a) => a.id)
    expect(defaultSelection(scan)).not.toContain(all.find((id) => id.endsWith('secret-notes.txt')))
    const result = await harness.run<BackupResult>('backup', (ctx) =>
      engine.run(
        {
          scanId: scan.id,
          selectedArtifactIds: all,
          outputPath: path.join(outDir, 's.devbackup'),
          password: 'correct horse',
          label: 'x',
        },
        ctx,
      ),
    )
    expect(result.warnings.some((w) => w.includes('sensitive item'))).toBe(true)
    const sensitive = result.manifest.projects[0]!.providers[0]!.artifacts.find(
      (a) => a.label === 'secret-notes.txt',
    )
    expect(sensitive?.sensitivity).toBe('sensitive')
  })
})
