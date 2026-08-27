import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ScanSession } from '@devmig/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderRegistry } from '../providers/registry'
import {
  createFileProvider,
  createGlobalProvider,
  directJobContext,
  makeJobHarness,
  makeTempRoot,
  makeTestEnv,
  writeFiles,
  type TempRoot,
  type TestEnv,
} from '../testing/engine-fixtures'
import { DefaultProjectScanner } from './project-scanner'

/** `expect.stringContaining` typed as string so it can sit inside typed matcher objects. */
const containing = (text: string): string => expect.stringContaining(text) as string

describe('DefaultProjectScanner', () => {
  let tmp: TempRoot
  let test: TestEnv
  let projA: string
  let projB: string

  beforeEach(async () => {
    tmp = await makeTempRoot('devmig-scanner-')
    test = await makeTestEnv(tmp.root)
    projA = path.join(tmp.root, 'home', 'Projects', 'alpha')
    projB = path.join(tmp.root, 'home', 'Projects', 'beta')
    await writeFiles(projA, { 'notes.txt': 'a', 'settings.json': '{"a":1}', 'README.md': '#' })
    await writeFiles(projB, { 'todo.txt': 'b' })
    await writeFiles(test.claudeConfigDir, { 'settings.json': '{"theme":"dark"}' })
  })
  afterEach(async () => {
    await tmp.cleanup()
  })

  describe('describeProject', () => {
    it('canonicalizes ~, trailing slashes and symlinks and derives a stable id', async () => {
      const scanner = new DefaultProjectScanner({ env: test.env, registry: new ProviderRegistry() })
      const ctx = directJobContext(test.env.logger)
      const link = path.join(tmp.root, 'link-to-alpha')
      await fs.symlink(projA, link)
      const viaHome = await scanner.describeProject('~/Projects/alpha/', ctx)
      const viaLink = await scanner.describeProject(link, ctx)
      expect(viaHome.canonicalPath).toBe(projA)
      expect(viaHome.realPath).toBe(projA)
      expect(viaHome.originalPath).toBe('~/Projects/alpha/')
      expect(viaHome.name).toBe('alpha')
      expect(viaHome.id).toMatch(/^[0-9a-f]{16}$/)
      expect(viaLink.realPath).toBe(projA)
      expect(viaLink.canonicalPath).toBe(link)
      expect(viaLink.id).toBe(viaHome.id)
      expect(viaHome.git).toBeUndefined() // fake exec: git "not installed"
      expect(viaHome.detectedProviders).toEqual([])
    })

    it('rejects missing paths, files and relative paths with stable codes', async () => {
      const scanner = new DefaultProjectScanner({ env: test.env, registry: new ProviderRegistry() })
      const ctx = directJobContext(test.env.logger)
      await expect(scanner.describeProject(path.join(tmp.root, 'nope'), ctx)).rejects.toMatchObject(
        { code: 'PATH_NOT_FOUND' },
      )
      await expect(
        scanner.describeProject(path.join(projA, 'notes.txt'), ctx),
      ).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' })
      await expect(scanner.describeProject('relative/dir', ctx)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
      await expect(scanner.describeProject('   ', ctx)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
    })
  })

  describe('scan', () => {
    it('runs every provider per project (registry order), scans global state and stores the session', async () => {
      const files = createFileProvider()
      const global = createGlobalProvider({ withCredential: true })
      const registry = new ProviderRegistry().register(files).register(global)
      const scanner = new DefaultProjectScanner({ env: test.env, registry })
      const harness = makeJobHarness(test.env.logger)
      const session = await harness.run('scan', (ctx) =>
        scanner.scan([projA, projB], { includeGlobal: true }, ctx),
      )

      expect(ScanSession.parse(session)).toEqual(session)
      expect(scanner.getSession(session.id)).toEqual(session)
      expect(scanner.getSession('nope')).toBeUndefined()
      expect(session.projects.map((p) => p.project.name)).toEqual(['alpha', 'beta'])
      expect(session.projects[0]?.providers.map((r) => r.providerId)).toEqual([
        'files',
        'globalcfg',
      ])
      expect(session.projects[0]?.project.detectedProviders).toEqual(['files'])
      const alphaFiles = session.projects[0]?.providers[0]
      expect(alphaFiles?.artifacts.map((a) => a.id).sort()).toEqual([
        `files:${session.projects[0]!.project.id}:notes.txt`,
        `files:${session.projects[0]!.project.id}:settings`,
      ])
      expect(
        alphaFiles?.artifacts.every((a) => a.projectId === session.projects[0]!.project.id),
      ).toBe(true)
      expect(session.projects[0]?.estimatedBytes).toBe(1 + 7)
      expect(session.global.map((g) => g.providerId)).toEqual(['globalcfg'])
      expect(session.global[0]?.artifacts.map((a) => [a.id, a.sensitivity, a.selectable])).toEqual([
        ['globalcfg:settings', 'safe', true],
        ['globalcfg:credentials', 'credential', false],
      ])
      expect(files.calls.scan).toBe(2)

      const phases = harness.events.map((e) => e.phase)
      expect(phases).toContain('DISCOVERING')
      expect(phases).toContain('SCANNING')
      expect(phases.indexOf('DISCOVERING')).toBeLessThan(phases.indexOf('SCANNING'))
      expect(harness.events.some((e) => e.projectId && e.providerId)).toBe(true)
      expect(harness.events.at(-1)?.phase).toBe('COMPLETE')
    })

    it('skips the global scan unless requested', async () => {
      const registry = new ProviderRegistry().register(createGlobalProvider())
      const scanner = new DefaultProjectScanner({ env: test.env, registry })
      const session = await scanner.scan(
        [projA],
        { includeGlobal: false },
        directJobContext(test.env.logger),
      )
      expect(session.global).toEqual([])
    })

    it('dedupes paths resolving to the same directory and warns about nested selections', async () => {
      const registry = new ProviderRegistry().register(createFileProvider())
      const scanner = new DefaultProjectScanner({ env: test.env, registry })
      const nested = path.join(projA, 'packages', 'inner')
      await writeFiles(nested, { 'x.txt': 'x' })
      const link = path.join(tmp.root, 'alpha-link')
      await fs.symlink(projA, link)
      const session = await scanner.scan(
        [projA, link, `${projA}/`, nested],
        { includeGlobal: false },
        directJobContext(test.env.logger),
      )
      expect(session.projects.map((p) => p.project.realPath)).toEqual([projA, nested])
      expect(session.warnings.filter((w) => w.includes('same directory'))).toHaveLength(2)
      expect(session.warnings.some((w) => w.includes('is inside'))).toBe(true)
    })

    it('warns when a selected project is a worktree of another selected project', async () => {
      const registry = new ProviderRegistry().register(createFileProvider())
      const scanner = new DefaultProjectScanner({ env: test.env, registry })
      const original = scanner.describeProject.bind(scanner)
      scanner.describeProject = async (p, ctx) => {
        const d = await original(p, ctx)
        if (d.realPath === projA) {
          d.git = {
            root: projA,
            remotes: [],
            head: 'a',
            branch: 'main',
            detached: false,
            isLinkedWorktree: false,
            worktrees: [
              {
                path: projA,
                branch: 'main',
                head: 'a',
                isPrimary: true,
                detached: false,
                locked: false,
                prunable: false,
              },
              {
                path: projB,
                branch: 'wt',
                head: 'b',
                isPrimary: false,
                detached: false,
                locked: false,
                prunable: false,
                relativeToPrimary: '../beta',
              },
            ],
          }
        }
        return d
      }
      const session = await scanner.scan(
        [projA, projB],
        { includeGlobal: false },
        directJobContext(test.env.logger),
      )
      expect(session.projects).toHaveLength(2)
      expect(session.warnings.some((w) => w.includes('is a Git worktree of'))).toBe(true)
    })

    it('isolates a throwing provider and an invalid result without killing the scan', async () => {
      const broken = createFileProvider({ id: 'broken', failScan: new Error('disk on fire') })
      const invalid = createFileProvider({ id: 'invalid' })
      invalid.scanProject = () => Promise.resolve({ nonsense: true } as never)
      const registry = new ProviderRegistry()
        .register(broken)
        .register(createFileProvider())
        .register(invalid)
        .register(createGlobalProvider({ failGlobalScan: new Error('global boom') }))
      const scanner = new DefaultProjectScanner({ env: test.env, registry })
      const session = await scanner.scan(
        [projA],
        { includeGlobal: true },
        directJobContext(test.env.logger),
      )
      const byProvider = new Map(session.projects[0]!.providers.map((r) => [r.providerId, r]))
      expect(byProvider.get('broken')).toMatchObject({
        detected: false,
        artifacts: [],
        warnings: ['Scan failed: disk on fire'],
      })
      expect(byProvider.get('invalid')?.detected).toBe(false)
      expect(byProvider.get('invalid')?.warnings[0]).toContain('invalid')
      expect(byProvider.get('files')?.detected).toBe(true)
      expect(
        session.projects[0]?.warnings.some(
          (w) => w.startsWith('Fake files: ') || w.includes('disk on fire'),
        ),
      ).toBe(true)
      expect(session.global[0]).toMatchObject({
        providerId: 'globalcfg',
        detected: false,
        warnings: ['Scan failed: global boom'],
      })
      expect(test.records.some((r) => r.level === 'warn' && r.msg === 'Provider scan failed')).toBe(
        true,
      )
    })

    it('prefixes un-namespaced artifact ids and rejects duplicates with PROVIDER_FAILED', async () => {
      const raw = createFileProvider({ rawArtifactIds: true })
      const scanner = new DefaultProjectScanner({
        env: test.env,
        registry: new ProviderRegistry().register(raw),
      })
      const session = await scanner.scan(
        [projA],
        { includeGlobal: false },
        directJobContext(test.env.logger),
      )
      const ids = session.projects[0]!.providers[0]!.artifacts.map((a) => a.id)
      expect(ids.every((id) => id.startsWith('files:'))).toBe(true)

      const dup = createFileProvider({ duplicateIds: true })
      const scanner2 = new DefaultProjectScanner({
        env: test.env,
        registry: new ProviderRegistry().register(dup),
      })
      await expect(
        scanner2.scan([projA], { includeGlobal: false }, directJobContext(test.env.logger)),
      ).rejects.toMatchObject({
        code: 'PROVIDER_FAILED',
        message: containing('duplicate artifact id'),
      })
    })

    it('stops promptly when cancelled', async () => {
      const controller = new AbortController()
      const slow = createFileProvider()
      const originalScan = slow.scanProject.bind(slow)
      slow.scanProject = async (project, ctx) => {
        controller.abort()
        return originalScan(project, ctx)
      }
      const scanner = new DefaultProjectScanner({
        env: test.env,
        registry: new ProviderRegistry().register(slow),
      })
      await expect(
        scanner.scan(
          [projA, projB],
          { includeGlobal: false },
          directJobContext(test.env.logger, { signal: controller.signal }),
        ),
      ).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(slow.calls.scan).toBe(1)
    })
  })
})
