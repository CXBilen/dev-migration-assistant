/**
 * Real git fixture: a repository with a linked worktree, an ignored .env.local, a tracked .nvmrc and
 * an excluded local key. Backup → plan → restore onto a fake second Mac (different user + path) → verify.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createPathMapper, deriveWorktreeMappings, readProjectGitInfo } from '@devmig/core'
import type { ManifestProject, PathMapping, ProjectDescriptor } from '@devmig/model'
import { hashFile, stableId } from '@devmig/shared'
import {
  FIXTURE_ENV_SECRETS,
  captureGitState,
  compareGitState,
  createFakeHome,
  createGitRepoFixture,
  makeTempRoot,
  type GitRepoFixture,
  type TempRoot,
} from '@devmig/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROJECT_FILES_PROVIDER_ID, ProjectFilesProvider } from './project-files-provider'
import {
  backupContext,
  planningContext,
  restoreContext,
  scanContext,
  verifyContext,
} from './test-context'

let tmp: TempRoot
beforeEach(async () => {
  tmp = await makeTempRoot('devmig-project-files-int-')
})
afterEach(async () => {
  await tmp.cleanup()
})

const DEV_KEY = '-----BEGIN PRIVATE KEY-----\nMIIfixturekeymaterial\n-----END PRIVATE KEY-----\n'

async function describeFixture(fixture: GitRepoFixture): Promise<ProjectDescriptor> {
  const git = await readProjectGitInfo(fixture.path, fixture.exec)
  if (!git) throw new Error('fixture is not a git repository')
  return {
    id: stableId(fixture.path),
    name: fixture.name,
    originalPath: fixture.path,
    canonicalPath: fixture.path,
    realPath: fixture.path,
    git,
    detectedProviders: [],
  }
}

describe('project-files provider against a real git repository', () => {
  it('backs up only git-ignored local files (project + worktree) and restores them under a new path', async () => {
    const source = await createFakeHome(path.join(tmp.root, 'source'), { userName: 'alice' })
    const fixture = await createGitRepoFixture({
      root: source.projectsDir,
      name: 'demo',
      homeDir: source.homeDir,
    })
    // Tracked .nvmrc (restored by Git), excluded certs/dev.key (ours), worktree .env.local (ours).
    await fs.writeFile(path.join(fixture.path, '.nvmrc'), '22\n')
    await fixture.exec('git', ['add', '--', '.nvmrc'], { cwd: fixture.path })
    await fixture.exec('git', ['commit', '--quiet', '-m', 'chore: pin node'], { cwd: fixture.path })
    await fs.mkdir(path.join(fixture.path, 'certs'))
    await fs.writeFile(path.join(fixture.path, 'certs', 'dev.key'), DEV_KEY, { mode: 0o600 })
    await fs.appendFile(path.join(fixture.path, '.git', 'info', 'exclude'), 'certs/\n')
    // Untracked, not ignored: the Git provider carries it → info row here.
    await fs.writeFile(path.join(fixture.path, '.node-version'), '22.12.0\n')
    const worktree = fixture.worktree!
    await fs.writeFile(path.join(worktree.path, '.env.local'), 'WT_SECRET=wt-secret-value-123456\n')

    const project = await describeFixture(fixture)
    expect(project.git?.worktrees.map((w) => w.path)).toContain(worktree.path)
    const before = await captureGitState(fixture.path, fixture.exec, { env: fixture.env })
    const beforeHashes = new Map<string, string>()
    for (const file of ['.env.local', '.nvmrc', 'certs/dev.key', '.node-version']) {
      beforeHashes.set(file, (await hashFile(path.join(fixture.path, file))).sha256)
    }

    const provider = new ProjectFilesProvider()
    const scan = await provider.scanProject(
      project,
      scanContext({ homeDir: source.homeDir, exec: fixture.exec, allProjects: [project] }),
    )
    const byKey = new Map(
      scan.artifacts.map((a) => {
        const meta = a.meta as { worktreeIndex: number; relpath: string }
        return [`${meta.worktreeIndex}:${meta.relpath}`, a]
      }),
    )
    expect(byKey.get('0:.env.local')).toMatchObject({
      sensitivity: 'sensitive',
      includedByDefault: false,
      selectable: true,
    })
    expect(byKey.get('0:certs/dev.key')).toMatchObject({
      sensitivity: 'sensitive',
      includedByDefault: false,
      selectable: true,
    })
    expect((byKey.get('0:certs/dev.key')?.meta as { classification: string }).classification).toBe(
      'credential',
    )
    expect(byKey.get('0:.nvmrc')).toMatchObject({ selectable: false, includedByDefault: false })
    expect(byKey.get('0:.nvmrc')?.reasons).toContain('Captured by Git working tree state')
    expect(byKey.get('0:.node-version')).toMatchObject({ selectable: false })
    expect(byKey.get('1:.env.local')).toMatchObject({ sensitivity: 'sensitive', selectable: true })
    expect(byKey.get('1:.env.local')?.label).toBe('.env.local · demo-onboarding')
    expect(scan.summary).toEqual(
      expect.arrayContaining([
        {
          label: '.env.local detected',
          status: 'warn',
          detail: 'sensitive — excluded unless you opt in',
        },
        {
          label: '.env.local (demo-onboarding) detected',
          status: 'warn',
          detail: 'sensitive — excluded unless you opt in',
        },
        expect.objectContaining({
          label: '2 files are captured by Git working tree state',
          status: 'info',
        }),
      ]),
    )
    for (const secret of [...fixture.secrets, 'wt-secret-value-123456']) {
      expect(JSON.stringify(scan)).not.toContain(secret)
    }

    // The user opts in to every selectable file.
    const selected = scan.artifacts.filter((a) => a.selectable)
    expect(selected).toHaveLength(3)
    const relDir = `projects/${project.id}/project-files`
    const payloadRoot = path.join(tmp.root, 'payload')
    const stagingDir = path.join(payloadRoot, ...relDir.split('/'))
    const tempDir = path.join(tmp.root, 'backup-temp')
    await fs.mkdir(stagingDir, { recursive: true })
    await fs.mkdir(tempDir, { recursive: true })
    const output = await provider.createBackupArtifacts(
      { project, artifacts: selected, scan },
      backupContext({ homeDir: source.homeDir, exec: fixture.exec, stagingDir, tempDir, relDir }),
    )
    expect(output.artifacts.map((a) => a.payloadPath).sort()).toEqual([
      `${relDir}/files/0/.env.local`,
      `${relDir}/files/0/certs/dev.key`,
      `${relDir}/files/1/.env.local`,
    ])
    expect(output.summary).toMatchObject({ fileCount: 3, sensitiveCount: 3, worktreeCount: 2 })

    // Destination: another user, another folder; worktree mapping derived exactly like the engine does.
    const destination = await createFakeHome(path.join(tmp.root, 'destination'), {
      userName: 'bob',
    })
    const newProjectPath = path.join(destination.projectsDir, 'work', 'demo')
    const manifestProject: ManifestProject = {
      id: project.id,
      name: project.name,
      originalPath: project.originalPath,
      canonicalPath: project.canonicalPath,
      git: project.git,
      providers: [
        {
          providerId: PROJECT_FILES_PROVIDER_ID,
          schemaVersion: 1,
          artifacts: output.artifacts,
          summary: {},
        },
      ],
    }
    const primary: PathMapping = {
      projectId: project.id,
      oldPath: fixture.path,
      newPath: newProjectPath,
    }
    const mappings = [
      primary,
      ...deriveWorktreeMappings(manifestProject, primary, { homeDir: destination.homeDir }),
    ]
    const newWorktreePath = path.join(destination.projectsDir, 'work', 'demo-onboarding')
    expect(mappings.map((m) => m.newPath)).toContain(newWorktreePath)
    const mapper = createPathMapper(mappings, { homeDir: destination.homeDir })
    expect(mapper.mapPath(worktree.path).newPath).toBe(newWorktreePath)

    const input = {
      project: {
        id: project.id,
        name: project.name,
        oldPath: fixture.path,
        newPath: newProjectPath,
      },
      section: manifestProject.providers[0]!,
      artifacts: output.artifacts,
    }
    const plan = await provider.planRestore(
      input,
      planningContext({ homeDir: destination.homeDir, exec: fixture.exec, payloadRoot, mappings }),
    )
    expect(plan.collisions).toEqual([])
    expect(plan.steps.map((s) => s.destination).sort()).toEqual(
      [
        path.join(newProjectPath, '.env.local'),
        path.join(newProjectPath, 'certs', 'dev.key'),
        path.join(newWorktreePath, '.env.local'),
      ].sort(),
    )
    expect(plan.preflight.map((p) => [p.id, p.status, p.blocking])).toEqual([
      ['destination:0', 'warn', false],
      ['destination:1', 'warn', false],
    ])

    // The Git provider runs first (clone + worktree add) and creates both folders; mimic that.
    await fs.mkdir(newProjectPath, { recursive: true })
    await fs.mkdir(newWorktreePath, { recursive: true })
    const restoreTemp = path.join(tmp.root, 'restore-temp')
    await fs.mkdir(restoreTemp)
    const result = await provider.restore(
      plan,
      input,
      restoreContext({
        homeDir: destination.homeDir,
        exec: fixture.exec,
        payloadRoot,
        mappings,
        roots: [
          newProjectPath,
          newWorktreePath,
          destination.claudeConfigDir,
          destination.claudeJsonPath,
        ],
        tempDir: restoreTemp,
      }),
    )
    expect(result.status).toBe('ok')
    expect(await fs.readFile(path.join(newProjectPath, '.env.local'), 'utf8')).toContain(
      FIXTURE_ENV_SECRETS.API_KEY,
    )
    expect(await fs.readFile(path.join(newWorktreePath, '.env.local'), 'utf8')).toContain(
      'WT_SECRET=',
    )
    expect(await fs.readFile(path.join(newProjectPath, 'certs', 'dev.key'), 'utf8')).toBe(DEV_KEY)
    for (const file of ['.env.local', 'certs/dev.key']) {
      expect((await fs.stat(path.join(newProjectPath, file))).mode & 0o777).toBe(0o600)
    }
    expect(await fs.stat(path.join(newProjectPath, '.nvmrc')).catch(() => null)).toBeNull()

    const verification = await provider.verify(
      { plan, result, input },
      verifyContext({ homeDir: destination.homeDir, exec: fixture.exec, payloadRoot, mappings }),
    )
    expect(verification.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass'])

    // Running again is safe: everything collides and is skipped by default.
    const plan2 = await provider.planRestore(
      input,
      planningContext({ homeDir: destination.homeDir, exec: fixture.exec, payloadRoot, mappings }),
    )
    expect(plan2.collisions.map((c) => c.kind)).toEqual([
      'file-exists',
      'file-exists',
      'file-exists',
    ])
    const result2 = await provider.restore(
      plan2,
      input,
      restoreContext({
        homeDir: destination.homeDir,
        exec: fixture.exec,
        payloadRoot,
        mappings,
        roots: [newProjectPath, newWorktreePath],
        tempDir: restoreTemp,
      }),
    )
    expect(result2.items.every((i) => i.status === 'info')).toBe(true)

    // Source machine untouched: same git state, same file hashes, nothing new in the source home.
    const after = await captureGitState(fixture.path, fixture.exec, { env: fixture.env })
    expect(compareGitState(before, after)).toEqual({ equal: true, differences: [] })
    for (const [file, hash] of beforeHashes) {
      expect((await hashFile(path.join(fixture.path, file))).sha256, file).toBe(hash)
    }
    expect(await fs.readdir(source.claudeConfigDir)).toEqual([])
  })
})
