import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PathMapping, ProjectDescriptor } from '@devmig/model'
import { MigrationError, hashFile } from '@devmig/shared'
import { createFakeExec, makeTempRoot, matchCommand, type TempRoot } from '@devmig/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  categorizeRootFileName,
  discoverCandidates,
  isEnvFileName,
  isSafeRelpath,
} from './candidates'
import { checkIgnored, parseNulList } from './git-ignore'
import {
  PROJECT_FILES_PROVIDER_ID,
  ProjectFilesProvider,
  createProjectFilesProvider,
  resolveWorktreeRoots,
} from './project-files-provider'
import { ManifestFileMeta, PlanState, ScannedFileMeta } from './schema'
import {
  backupContext,
  plainProject,
  planningContext,
  restoreContext,
  scanContext,
  verifyContext,
} from './test-context'

let tmp: TempRoot
beforeEach(async () => {
  tmp = await makeTempRoot('devmig-project-files-')
})
afterEach(async () => {
  await tmp.cleanup()
})

async function write(file: string, content: string | Buffer, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, mode !== undefined ? { mode } : undefined)
}

const FAKE_PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7fixture',
  '-----END PRIVATE KEY-----',
  '',
].join('\n')

describe('candidate rules', () => {
  it('recognises env files but not templates', () => {
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
      expect(isEnvFileName(name), name).toBe(true)
    }
    for (const name of [
      '.env.example',
      '.env.sample',
      '.env.template',
      '.env.dist',
      'env',
      '.environment',
      '.env.',
    ]) {
      expect(isEnvFileName(name), name).toBe(false)
    }
  })

  it('categorises known root files and certificates', () => {
    expect(categorizeRootFileName('.nvmrc')).toBe('version-pin')
    expect(categorizeRootFileName('.npmrc')).toBe('package-manager')
    expect(categorizeRootFileName('.envrc')).toBe('direnv')
    expect(categorizeRootFileName('docker-compose.override.yml')).toBe('compose')
    expect(categorizeRootFileName('server.pem')).toBe('certificate')
    expect(categorizeRootFileName('.pem')).toBeNull()
    expect(categorizeRootFileName('package.json')).toBeNull()
    expect(categorizeRootFileName('settings.json')).toBeNull()
  })

  it('rejects unsafe relative paths', () => {
    expect(isSafeRelpath('.env')).toBe(true)
    expect(isSafeRelpath('certs/dev/a.pem')).toBe(true)
    expect(isSafeRelpath('../.env')).toBe(false)
    expect(isSafeRelpath('/etc/passwd')).toBe(false)
    expect(isSafeRelpath('a\nb')).toBe(false)
    expect(isSafeRelpath('a\\b')).toBe(false)
  })

  it('discovers root files and certs up to two levels deep, skipping symlinks and .vscode', async () => {
    const root = path.join(tmp.root, 'proj')
    await write(path.join(root, '.env.local'), 'A=1\n')
    await write(path.join(root, '.env.example'), 'A=\n')
    await write(path.join(root, '.nvmrc'), '22\n')
    await write(path.join(root, 'certs', 'dev.pem'), FAKE_PEM)
    await write(path.join(root, 'certs', 'sub', 'deep.crt'), 'cert\n')
    await write(path.join(root, 'certs', 'sub', 'deeper', 'too-deep.key'), 'key\n')
    await write(path.join(root, '.certs', 'other.p12'), Buffer.from([0x30, 0x82, 0x00]))
    await write(path.join(root, 'certs', 'README.md'), 'not a cert\n')
    await write(path.join(root, '.vscode', 'settings.json'), '{}\n')
    await write(path.join(root, 'src', 'index.ts'), 'export {}\n')
    await fs.symlink(path.join(root, '.env.local'), path.join(root, '.env.link'))

    const skipped: string[] = []
    const found = await discoverCandidates(root, {
      onSkip: (rel, reason) => skipped.push(`${rel}:${reason}`),
    })
    expect(found.map((c) => c.relpath)).toEqual([
      '.certs/other.p12',
      '.env.local',
      '.nvmrc',
      'certs/dev.pem',
      'certs/sub/deep.crt',
    ])
    expect(found.find((c) => c.relpath === '.nvmrc')?.category).toBe('version-pin')
    expect(found.find((c) => c.relpath === 'certs/dev.pem')?.sizeBytes).toBe(
      Buffer.byteLength(FAKE_PEM),
    )
    expect(skipped).toContain('.env.link:symbolic links are not migrated')
  })

  it('returns nothing for a missing directory', async () => {
    expect(await discoverCandidates(path.join(tmp.root, 'nope'))).toEqual([])
  })
})

describe('checkIgnored', () => {
  it('feeds paths through stdin with -z and parses the NUL-separated answer', async () => {
    const fake = createFakeExec([
      {
        match: matchCommand('git', 'check-ignore', '-z', '--stdin'),
        result: { stdout: '.env.local\0certs/dev.pem\0', exitCode: 0 },
      },
    ])
    const result = await checkIgnored(fake.exec, '/tmp/x', [
      '.env.local',
      '.nvmrc',
      'certs/dev.pem',
    ])
    expect(result.status).toBe('ok')
    expect([...result.ignored].sort()).toEqual(['.env.local', 'certs/dev.pem'])
    const call = fake.calls[0]
    expect(call?.args).toEqual(['check-ignore', '-z', '--stdin'])
    expect(call?.options?.cwd).toBe('/tmp/x')
    expect(call?.options?.input).toBe('.env.local\0.nvmrc\0certs/dev.pem\0')
    expect(call?.options?.reject).toBe(false)
  })

  it('treats exit code 1 as "nothing ignored" and 128 as unavailable', async () => {
    const none = createFakeExec([{ match: matchCommand('git'), result: { exitCode: 1 } }])
    expect((await checkIgnored(none.exec, '/tmp/x', ['.env'])).ignored.size).toBe(0)
    const fatal = createFakeExec([
      {
        match: matchCommand('git'),
        result: { exitCode: 128, stderr: 'fatal: not a git repository' },
      },
    ])
    const result = await checkIgnored(fatal.exec, '/tmp/x', ['.env'])
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('128')
  })

  it('reports unavailable when git is missing and rethrows cancellation', async () => {
    const missing = createFakeExec([])
    expect((await checkIgnored(missing.exec, '/tmp/x', ['.env'])).status).toBe('unavailable')
    const controller = new AbortController()
    controller.abort()
    const fake = createFakeExec([{ match: matchCommand('git'), result: { exitCode: 0 } }])
    await expect(
      checkIgnored(fake.exec, '/tmp/x', ['.env'], controller.signal),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
    })
  })

  it('never runs git for an empty or unsafe list', async () => {
    const fake = createFakeExec([])
    expect((await checkIgnored(fake.exec, '/tmp/x', [])).status).toBe('ok')
    expect((await checkIgnored(fake.exec, '/tmp/x', ['../x'])).status).toBe('ok')
    expect(fake.calls).toHaveLength(0)
    expect(parseNulList('a\0b\0\0')).toEqual(['a', 'b'])
  })
})

describe('resolveWorktreeRoots', () => {
  it('lists the project first and skips worktrees that are selected projects themselves', () => {
    const project: ProjectDescriptor = {
      ...plainProject('/tmp/demo'),
      git: {
        root: '/tmp/demo',
        remotes: [],
        head: 'abc',
        branch: 'main',
        detached: false,
        isLinkedWorktree: false,
        worktrees: [
          {
            path: '/tmp/demo',
            branch: 'main',
            head: 'abc',
            isPrimary: true,
            detached: false,
            locked: false,
            prunable: false,
          },
          {
            path: '/tmp/demo-onboarding',
            branch: 'feature/onboarding',
            head: 'def',
            isPrimary: false,
            detached: false,
            locked: false,
            prunable: false,
          },
          {
            path: '/tmp/demo-other',
            branch: 'other',
            head: 'ghi',
            isPrimary: false,
            detached: false,
            locked: false,
            prunable: false,
          },
        ],
      },
    }
    const other = plainProject('/tmp/demo-other')
    const roots = resolveWorktreeRoots(project, [project, other])
    expect(roots.map((r) => [r.index, r.path])).toEqual([
      [0, '/tmp/demo'],
      [1, '/tmp/demo-onboarding'],
    ])
  })
})

describe('ProjectFilesProvider', () => {
  const provider = new ProjectFilesProvider()

  it('exposes the expected identity', () => {
    const created = createProjectFilesProvider()
    expect(created.id).toBe(PROJECT_FILES_PROVIDER_ID)
    expect(created.displayName).toBe('Project files')
    expect(created.supportsGlobal).toBe(false)
    expect(created.schemaVersion).toBe(1)
  })

  it('scans a non-git directory: every candidate listed, env sensitive and off, .nvmrc safe and on', async () => {
    const root = path.join(tmp.root, 'plain')
    await write(path.join(root, '.env.local'), 'API_KEY=sk-test-1234567890abcdef\n')
    await write(path.join(root, '.nvmrc'), '22\n')
    await write(path.join(root, '.npmrc'), 'save-exact=true\n')
    const exec = createFakeExec([])
    const result = await provider.scanProject(
      plainProject(root),
      scanContext({ homeDir: tmp.root, exec: exec.exec }),
    )

    expect(exec.calls).toHaveLength(0)
    expect(result.detected).toBe(true)
    const byRel = new Map(result.artifacts.map((a) => [(a.meta as { relpath: string }).relpath, a]))
    const env = byRel.get('.env.local')
    expect(env?.sensitivity).toBe('sensitive')
    expect(env?.includedByDefault).toBe(false)
    expect(env?.selectable).toBe(true)
    expect(env?.reasons.join(' ')).toMatch(/Environment file/)
    expect(env?.id).toBe(`project-files:${plainProject(root).id}:0:.env.local`)
    const nvmrc = byRel.get('.nvmrc')
    expect(nvmrc?.sensitivity).toBe('safe')
    expect(nvmrc?.includedByDefault).toBe(true)
    expect(byRel.get('.npmrc')?.includedByDefault).toBe(false)
    expect(result.estimatedBytes).toBe(3)
    expect(result.summary).toEqual(
      expect.arrayContaining([
        {
          label: '.env.local detected',
          status: 'warn',
          detail: 'sensitive — excluded unless you opt in',
        },
        { label: '.nvmrc', status: 'ok' },
        { label: 'Not a Git repository — all local files listed', status: 'info' },
      ]),
    )
    for (const artifact of result.artifacts)
      expect(() => ScannedFileMeta.parse(artifact.meta)).not.toThrow()
    for (const artifact of result.artifacts) {
      expect(JSON.stringify(artifact)).not.toContain('sk-test-1234567890abcdef')
    }
  })

  it('in a git repo only ignored files are selectable; tracked ones become info rows', async () => {
    const root = path.join(tmp.root, 'repo')
    await write(path.join(root, '.env.local'), 'TOKEN=abcdef123456\n')
    await write(path.join(root, '.nvmrc'), '22\n')
    const exec = createFakeExec([
      {
        match: matchCommand('git', 'check-ignore'),
        result: { stdout: '.env.local\0', exitCode: 0 },
      },
    ])
    const project: ProjectDescriptor = {
      ...plainProject(root),
      git: {
        root,
        remotes: [],
        head: 'abc',
        branch: 'main',
        detached: false,
        isLinkedWorktree: false,
        worktrees: [
          {
            path: root,
            branch: 'main',
            head: 'abc',
            isPrimary: true,
            detached: false,
            locked: false,
            prunable: false,
          },
        ],
      },
    }
    const result = await provider.scanProject(
      project,
      scanContext({ homeDir: tmp.root, exec: exec.exec }),
    )
    const byRel = new Map(result.artifacts.map((a) => [(a.meta as { relpath: string }).relpath, a]))
    expect(byRel.get('.env.local')?.selectable).toBe(true)
    expect(byRel.get('.env.local')?.includedByDefault).toBe(false)
    const nvmrc = byRel.get('.nvmrc')
    expect(nvmrc?.selectable).toBe(false)
    expect(nvmrc?.includedByDefault).toBe(false)
    expect(nvmrc?.reasons).toContain('Captured by Git working tree state')
    expect((nvmrc?.meta as { gitStatus: string }).gitStatus).toBe('captured-by-git')
    expect(result.summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '1 file is captured by Git working tree state',
          status: 'info',
        }),
      ]),
    )
    expect(exec.calls[0]?.options?.cwd).toBe(root)
  })

  it('lists everything with a warning when git check-ignore fails', async () => {
    const root = path.join(tmp.root, 'repo2')
    await write(path.join(root, '.nvmrc'), '22\n')
    const exec = createFakeExec([
      { match: matchCommand('git'), result: { exitCode: 128, stderr: 'boom' } },
    ])
    const project: ProjectDescriptor = {
      ...plainProject(root),
      git: {
        root,
        remotes: [],
        head: null,
        branch: null,
        detached: false,
        isLinkedWorktree: false,
        worktrees: [],
      },
    }
    const result = await provider.scanProject(
      project,
      scanContext({ homeDir: tmp.root, exec: exec.exec }),
    )
    expect(result.artifacts[0]?.selectable).toBe(true)
    expect(result.warnings[0]).toMatch(/Could not ask Git/)
  })

  it('labels a private key as credential-class: selectable, off by default, stored as sensitive', async () => {
    const root = path.join(tmp.root, 'keys')
    await write(path.join(root, 'certs', 'dev.pem'), FAKE_PEM)
    await write(
      path.join(root, 'certs', 'dev.crt'),
      '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n',
    )
    const result = await provider.scanProject(
      plainProject(root),
      scanContext({ homeDir: tmp.root }),
    )
    const pem = result.artifacts.find(
      (a) => (a.meta as { relpath: string }).relpath === 'certs/dev.pem',
    )
    expect(pem?.sensitivity).toBe('sensitive')
    expect((pem?.meta as { classification: string }).classification).toBe('credential')
    expect(pem?.selectable).toBe(true)
    expect(pem?.includedByDefault).toBe(false)
    expect(pem?.reasons[0]).toMatch(/Private key material/)
    expect(pem?.reasons).toContain('PEM key/certificate file')
    expect(pem?.description).toContain('private key')
    const crt = result.artifacts.find(
      (a) => (a.meta as { relpath: string }).relpath === 'certs/dev.crt',
    )
    expect(crt?.sensitivity).toBe('safe')
    expect(crt?.includedByDefault).toBe(true)
    expect(result.summary).toEqual(
      expect.arrayContaining([
        {
          label: 'certs/dev.pem detected',
          status: 'warn',
          detail: 'private key — excluded unless you opt in',
        },
      ]),
    )
  })

  it('reports nothing for an empty directory', async () => {
    const root = path.join(tmp.root, 'empty')
    await fs.mkdir(root)
    const result = await provider.scanProject(
      plainProject(root),
      scanContext({ homeDir: tmp.root }),
    )
    expect(result.detected).toBe(false)
    expect(result.artifacts).toEqual([])
    expect(result.summary).toEqual([{ label: 'No local project files found', status: 'info' }])
  })

  it('rejects manifest metadata with an escaping relpath', () => {
    expect(() =>
      ManifestFileMeta.parse({
        relpath: '../.env',
        worktreeIndex: 0,
        worktreeRoot: '/tmp/x',
        mode: 0o600,
        sha256: 'a'.repeat(64),
        category: 'env',
        classification: 'sensitive',
        indexPath: 'projects/p/project-files/index.json',
      }),
    ).toThrow()
  })

  describe('backup → plan → restore → verify (no git)', () => {
    async function scanAndBackup(sourceRoot: string) {
      const project = plainProject(sourceRoot)
      const scan = await provider.scanProject(project, scanContext({ homeDir: tmp.root }))
      const stagingDir = path.join(tmp.root, 'staging', 'projects', project.id, 'project-files')
      const tempDir = path.join(tmp.root, 'temp')
      await fs.mkdir(stagingDir, { recursive: true })
      await fs.mkdir(tempDir, { recursive: true })
      const selected = scan.artifacts.filter((a) => a.selectable)
      const output = await provider.createBackupArtifacts(
        { project, artifacts: selected, scan },
        backupContext({
          homeDir: tmp.root,
          stagingDir,
          tempDir,
          relDir: `projects/${project.id}/project-files`,
        }),
      )
      return { project, scan, output, payloadRoot: path.join(tmp.root, 'staging') }
    }

    it('round-trips files to a remapped destination honouring skip and backup-then-replace', async () => {
      const sourceRoot = path.join(tmp.root, 'Users', 'alice', 'demo')
      await write(
        path.join(sourceRoot, '.env.local'),
        `DB=${sourceRoot}/db.sqlite\nTOKEN=abcdef123456\n`,
        0o644,
      )
      await write(path.join(sourceRoot, '.nvmrc'), '22\n', 0o644)
      await write(path.join(sourceRoot, '.tool-versions'), 'nodejs 22.12.0\n', 0o755)
      const { project, output, payloadRoot } = await scanAndBackup(sourceRoot)

      expect(output.schemaVersion).toBe(1)
      expect(output.artifacts.map((a) => a.payloadPath).sort()).toEqual([
        `projects/${project.id}/project-files/files/0/.env.local`,
        `projects/${project.id}/project-files/files/0/.nvmrc`,
        `projects/${project.id}/project-files/files/0/.tool-versions`,
      ])
      const index = JSON.parse(
        await fs.readFile(
          path.join(payloadRoot, 'projects', project.id, 'project-files', 'index.json'),
          'utf8',
        ),
      ) as { files: { relpath: string; sha256: string; mode: number; sensitivity: string }[] }
      expect(index.files).toHaveLength(3)
      const envEntry = index.files.find((f) => f.relpath === '.env.local')
      expect(envEntry?.sha256).toBe((await hashFile(path.join(sourceRoot, '.env.local'))).sha256)
      expect(envEntry?.sensitivity).toBe('sensitive')
      expect(index.files.find((f) => f.relpath === '.tool-versions')?.mode).toBe(0o755)

      const newRoot = path.join(tmp.root, 'Users', 'bob', 'Projects', 'demo')
      const mappings: PathMapping[] = [
        { projectId: project.id, oldPath: sourceRoot, newPath: newRoot },
      ]
      const section = {
        providerId: PROJECT_FILES_PROVIDER_ID,
        schemaVersion: 1,
        artifacts: output.artifacts,
        summary: {},
      }
      const input = {
        project: { id: project.id, name: project.name, oldPath: sourceRoot, newPath: newRoot },
        section,
        artifacts: output.artifacts,
      }

      // Plan against an empty destination: no collisions, destination folder warning (non-blocking).
      const plan = await provider.planRestore(
        input,
        planningContext({ homeDir: tmp.root, payloadRoot, mappings }),
      )
      expect(plan.collisions).toEqual([])
      expect(plan.steps.map((s) => s.destination).sort()).toEqual([
        path.join(newRoot, '.env.local'),
        path.join(newRoot, '.nvmrc'),
        path.join(newRoot, '.tool-versions'),
      ])
      expect(plan.preflight).toEqual([
        expect.objectContaining({ id: 'destination:0', status: 'warn', blocking: false }),
      ])
      expect(plan.remap.affected).toEqual([{ label: 'Local project files relocated', count: 3 }])
      expect(plan.remap.unsupportedReferences).toHaveLength(1)
      expect(plan.remap.unsupportedReferences[0]?.location).toBe('.env.local')
      expect(plan.remap.unsupportedReferences[0]?.reason).toContain(sourceRoot)
      expect(() => PlanState.parse(plan.state)).not.toThrow()

      const tempDir = path.join(tmp.root, 'restore-temp')
      await fs.mkdir(tempDir, { recursive: true })
      // The Git provider runs first and creates the project folder; mimic that.
      await fs.mkdir(newRoot, { recursive: true })
      const result = await provider.restore(
        plan,
        input,
        restoreContext({ homeDir: tmp.root, payloadRoot, mappings, roots: [newRoot], tempDir }),
      )
      expect(result.status).toBe('ok')
      expect(await fs.readFile(path.join(newRoot, '.nvmrc'), 'utf8')).toBe('22\n')
      expect((await fs.stat(path.join(newRoot, '.env.local'))).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.join(newRoot, '.tool-versions'))).mode & 0o777).toBe(0o755)
      // Content is never rewritten, even when it mentions the old path.
      expect(await fs.readFile(path.join(newRoot, '.env.local'), 'utf8')).toContain(sourceRoot)
      expect(result.attention).toHaveLength(1)
      expect(result.attention?.[0]?.action).toBe('manual')
      expect(result.attention?.[0]?.title).toContain('may contain secrets')
      const verification = await provider.verify(
        { plan, result, input },
        verifyContext({ homeDir: tmp.root, payloadRoot, mappings }),
      )
      expect(verification.checks.every((c) => c.status === 'pass')).toBe(true)
      expect(verification.checks).toHaveLength(3)

      // Second plan: everything collides, default skip.
      await fs.writeFile(path.join(newRoot, '.nvmrc'), '20\n')
      const plan2 = await provider.planRestore(
        input,
        planningContext({ homeDir: tmp.root, payloadRoot, mappings }),
      )
      expect(plan2.collisions).toHaveLength(3)
      expect(plan2.collisions.every((c) => c.kind === 'file-exists' && c.policy === 'skip')).toBe(
        true,
      )
      expect(plan2.collisions[0]?.allowedPolicies).toEqual(['skip', 'backup-then-replace'])
      expect(plan2.preflight).toEqual([
        expect.objectContaining({ id: 'destination:0', status: 'pass' }),
      ])

      const nvmrcCollision = plan2.collisions.find((c) => c.path.endsWith('.nvmrc'))
      const result2 = await provider.restore(
        plan2,
        input,
        restoreContext({
          homeDir: tmp.root,
          payloadRoot,
          mappings,
          roots: [newRoot],
          tempDir,
          collisionDecisions: { [nvmrcCollision!.id]: 'backup-then-replace' },
        }),
      )
      expect(result2.status).toBe('ok')
      expect(await fs.readFile(path.join(newRoot, '.nvmrc'), 'utf8')).toBe('22\n')
      const entries = await fs.readdir(newRoot)
      const backups = entries.filter((e) => e.startsWith('.nvmrc.devmig-backup-'))
      expect(backups).toHaveLength(1)
      expect(await fs.readFile(path.join(newRoot, backups[0]!), 'utf8')).toBe('20\n')
      expect(result2.items.filter((i) => i.status === 'info')).toHaveLength(2)
      const verification2 = await provider.verify(
        { plan: plan2, result: result2, input },
        verifyContext({ homeDir: tmp.root, payloadRoot, mappings }),
      )
      const byId = new Map(verification2.checks.map((c) => [c.id, c]))
      expect(byId.get('verify:.nvmrc')?.status).toBe('pass')
      expect(byId.get('backup:.nvmrc')?.status).toBe('pass')
      expect(byId.get('skipped:.env.local')?.status).toBe('warn')
      expect(byId.get('skipped:.tool-versions')?.status).toBe('warn')

      // Source untouched.
      expect(await fs.readFile(path.join(sourceRoot, '.nvmrc'), 'utf8')).toBe('22\n')
    })

    it('reports a missing destination root per file instead of throwing', async () => {
      // ScopedFs currently rejects creating a root that does not exist yet (nearest existing ancestor is
      // above the root). Until that is relaxed in @devmig/shared the provider reports the file as failed.
      const sourceRoot = path.join(tmp.root, 'src-missing')
      await write(path.join(sourceRoot, '.nvmrc'), '22\n')
      const { project, output, payloadRoot } = await scanAndBackup(sourceRoot)
      const newRoot = path.join(tmp.root, 'missing', 'dest-proj')
      const mappings: PathMapping[] = [
        { projectId: project.id, oldPath: sourceRoot, newPath: newRoot },
      ]
      const input = {
        project: { id: project.id, name: project.name, oldPath: sourceRoot, newPath: newRoot },
        section: {
          providerId: PROJECT_FILES_PROVIDER_ID,
          schemaVersion: 1,
          artifacts: output.artifacts,
          summary: {},
        },
        artifacts: output.artifacts,
      }
      const plan = await provider.planRestore(
        input,
        planningContext({ homeDir: tmp.root, payloadRoot, mappings }),
      )
      const tempDir = path.join(tmp.root, 'rt-missing')
      await fs.mkdir(tempDir)
      const result = await provider.restore(
        plan,
        input,
        restoreContext({ homeDir: tmp.root, payloadRoot, mappings, roots: [newRoot], tempDir }),
      )
      if (result.status === 'ok') {
        // ScopedFs learned to create missing roots: the file must be there.
        expect(await fs.readFile(path.join(newRoot, '.nvmrc'), 'utf8')).toBe('22\n')
      } else {
        expect(result.status).toBe('failed')
        expect(result.items[0]?.status).toBe('error')
        expect(result.items[0]?.detail).toContain('does not exist')
        expect(await fs.stat(newRoot).catch(() => null)).toBeNull()
      }
    })

    it('refuses to write outside the approved roots and fails closed on tampered payloads', async () => {
      const sourceRoot = path.join(tmp.root, 'src-proj')
      await write(path.join(sourceRoot, '.nvmrc'), '22\n')
      const { project, output, payloadRoot } = await scanAndBackup(sourceRoot)
      const newRoot = path.join(tmp.root, 'dest-proj')
      await fs.mkdir(newRoot)
      const mappings: PathMapping[] = [
        { projectId: project.id, oldPath: sourceRoot, newPath: newRoot },
      ]
      const input = {
        project: { id: project.id, name: project.name, oldPath: sourceRoot, newPath: newRoot },
        section: {
          providerId: PROJECT_FILES_PROVIDER_ID,
          schemaVersion: 1,
          artifacts: output.artifacts,
          summary: {},
        },
        artifacts: output.artifacts,
      }
      const plan = await provider.planRestore(
        input,
        planningContext({ homeDir: tmp.root, payloadRoot, mappings }),
      )
      const tempDir = path.join(tmp.root, 'rt')
      await fs.mkdir(tempDir)
      await expect(
        provider.restore(
          plan,
          input,
          restoreContext({
            homeDir: tmp.root,
            payloadRoot,
            mappings,
            roots: [path.join(tmp.root, 'elsewhere')],
            tempDir,
          }),
        ),
      ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' })
      expect(await fs.readdir(newRoot)).toEqual([])

      // Tamper with the payload after planning: the file is reported, never written.
      const payloadFile = path.join(payloadRoot, ...output.artifacts[0]!.payloadPath.split('/'))
      await fs.writeFile(payloadFile, '20\n')
      const result = await provider.restore(
        plan,
        input,
        restoreContext({ homeDir: tmp.root, payloadRoot, mappings, roots: [newRoot], tempDir }),
      )
      expect(result.status).toBe('failed')
      expect(result.items[0]).toMatchObject({ status: 'error' })
      expect(await fs.stat(path.join(newRoot, '.nvmrc')).catch(() => null)).toBeNull()
    })

    it('rejects unsafe artifact metadata at plan time', async () => {
      const payloadRoot = path.join(tmp.root, 'payload')
      await fs.mkdir(payloadRoot)
      const artifact = {
        id: 'project-files:x',
        providerId: PROJECT_FILES_PROVIDER_ID,
        kind: 'file' as const,
        label: '.env',
        payloadPath: 'projects/x/project-files/files/0/.env',
        sizeBytes: 1,
        sensitivity: 'sensitive' as const,
        meta: {
          relpath: '../../.env',
          worktreeIndex: 0,
          worktreeRoot: '/tmp/x',
          mode: 0o600,
          sha256: 'a'.repeat(64),
          category: 'env',
          classification: 'sensitive',
          indexPath: 'x',
        },
      }
      await expect(
        provider.planRestore(
          {
            section: {
              providerId: PROJECT_FILES_PROVIDER_ID,
              schemaVersion: 1,
              artifacts: [artifact],
              summary: {},
            },
            artifacts: [artifact],
          },
          planningContext({ homeDir: tmp.root, payloadRoot, mappings: [] }),
        ),
      ).rejects.toBeInstanceOf(MigrationError)
    })

    it('stops at a cancelled signal without writing a payload', async () => {
      const sourceRoot = path.join(tmp.root, 'cancel')
      await write(path.join(sourceRoot, '.nvmrc'), '22\n')
      const project = plainProject(sourceRoot)
      const scan = await provider.scanProject(project, scanContext({ homeDir: tmp.root }))
      const stagingDir = path.join(tmp.root, 'stage-cancel')
      const tempDir = path.join(tmp.root, 'temp-cancel')
      await fs.mkdir(stagingDir)
      await fs.mkdir(tempDir)
      const controller = new AbortController()
      controller.abort()
      await expect(
        provider.createBackupArtifacts(
          { project, artifacts: scan.artifacts, scan },
          backupContext({ homeDir: tmp.root, stagingDir, tempDir, signal: controller.signal }),
        ),
      ).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(await fs.readdir(stagingDir)).toEqual([])
    })

    it('refuses to back up non-selectable artifacts', async () => {
      const sourceRoot = path.join(tmp.root, 'nonsel')
      await write(path.join(sourceRoot, '.nvmrc'), '22\n')
      const project = plainProject(sourceRoot)
      const scan = await provider.scanProject(project, scanContext({ homeDir: tmp.root }))
      const stagingDir = path.join(tmp.root, 'stage-nonsel')
      await fs.mkdir(stagingDir)
      const artifact = { ...scan.artifacts[0]!, selectable: false }
      await expect(
        provider.createBackupArtifacts(
          { project, artifacts: [artifact], scan },
          backupContext({ homeDir: tmp.root, stagingDir, tempDir: stagingDir }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    })
  })

  it('detect reports git availability without failing', async () => {
    const withGit = createFakeExec([
      { match: matchCommand('git', '--version'), result: { stdout: 'git version 2.50.1\n' } },
    ])
    const detection = await provider.detect({
      homeDir: tmp.root,
      claudeConfigDir: path.join(tmp.root, '.claude'),
      claudeJsonPath: path.join(tmp.root, '.claude.json'),
      env: {},
      exec: withGit.exec,
      logger: (await import('@devmig/shared')).noopLogger,
    })
    expect(detection).toMatchObject({ available: true, details: { git: 'available' } })
    const without = createFakeExec([])
    const detection2 = await provider.detect({
      ...detection,
      homeDir: tmp.root,
      claudeConfigDir: '',
      claudeJsonPath: '',
      env: {},
      exec: without.exec,
      logger: (await import('@devmig/shared')).noopLogger,
    })
    expect(detection2.details.git).toBe('missing')
    expect(detection2.notes).toHaveLength(1)
  })
})
