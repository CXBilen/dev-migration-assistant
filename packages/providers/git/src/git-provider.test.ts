import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RestorePlanningContext, ScanContext } from '@devmig/core'
import type { ManifestArtifact, ProjectDescriptor } from '@devmig/model'
import { MigrationError, noopLogger, type Exec } from '@devmig/shared'
import { createFakeExec, makeTempRoot, matchCommand, type TempRoot } from '@devmig/test-utils'
import { createGitProvider, GitProvider } from './git-provider'
import { backupAsidePathFor, backupAsidePathsFrom } from './plan'
import { GIT_SCHEMA_VERSION, PlanState, type RepositoryJson } from './schema'

const gitMissingExec: Exec = () => {
  throw new MigrationError('PATH_NOT_FOUND', 'Executable not found: git', {
    details: { file: 'git' },
  })
}

function baseCtx(root: string, exec: Exec) {
  return {
    homeDir: root,
    claudeConfigDir: path.join(root, '.claude'),
    claudeJsonPath: path.join(root, '.claude.json'),
    env: { HOME: root },
    exec,
    logger: noopLogger,
    signal: new AbortController().signal,
    progress: () => {},
  }
}

describe('backup-then-replace aside paths', () => {
  it('derives a timestamped sibling path', () => {
    const aside = backupAsidePathFor(
      '/Users/bob/Developer/demo',
      new Date('2026-08-28T01:02:03.456Z'),
    )
    expect(aside).toBe('/Users/bob/Developer/demo.devmig-backup-2026-08-28T01-02-03-456Z')
  })

  it('backupAsidePathsFrom returns the aside paths of a plan state and [] for anything else', () => {
    expect(backupAsidePathsFrom({})).toEqual([])
    expect(backupAsidePathsFrom({ asidePaths: ['/x'] })).toEqual([])
    const state: PlanState = {
      destination: '/Users/bob/Developer/demo',
      repositoryJson: '/payload/projects/p1/git/repository.json',
      bundlePath: null,
      restoreBundle: false,
      emptyRepository: true,
      primaryBranch: 'main',
      head: null,
      detached: false,
      remotes: [],
      upstreams: {},
      worktrees: [],
      ignored: [],
      destinationCollisionId: 'destination',
      backupAsidePath: '/Users/bob/Developer/demo.devmig-backup-1',
      asidePaths: [
        '/Users/bob/Developer/demo.devmig-backup-1',
        '/Users/bob/Developer/demo-onboarding.devmig-backup-1',
      ],
    }
    expect(backupAsidePathsFrom(PlanState.parse(state) as Record<string, unknown>)).toEqual(
      state.asidePaths,
    )
  })
})

describe('GitProvider (scripted exec)', () => {
  let tmp: TempRoot
  beforeEach(async () => {
    tmp = await makeTempRoot('devmig-git-unit-')
  })
  afterEach(async () => {
    await tmp.cleanup()
  })

  it('exposes the provider identity', () => {
    const provider = createGitProvider()
    expect(provider).toBeInstanceOf(GitProvider)
    expect(provider.id).toBe('git')
    expect(provider.displayName).toBe('Git')
    expect(provider.schemaVersion).toBe(GIT_SCHEMA_VERSION)
    expect(provider.supportsGlobal).toBe(false)
  })

  it('detect reports git as unavailable when the binary is missing', async () => {
    const provider = createGitProvider()
    const detection = await provider.detect({ ...baseCtx(tmp.root, gitMissingExec) })
    expect(detection).toMatchObject({ providerId: 'git', available: false })
    expect(detection.notes[0]).toMatch(/not found/)
    const fake = createFakeExec([
      { match: matchCommand('git', '--version'), result: { stdout: 'git version 2.44.0\n' } },
    ])
    const ok = await provider.detect({ ...baseCtx(tmp.root, fake.exec) })
    expect(ok).toMatchObject({ available: true, version: 'git version 2.44.0' })
  })

  it('scanProject reports non-repositories without touching git', async () => {
    const fake = createFakeExec([])
    const provider = createGitProvider()
    const project: ProjectDescriptor = {
      id: 'p1',
      name: 'plain',
      originalPath: tmp.root,
      canonicalPath: tmp.root,
      realPath: tmp.root,
      detectedProviders: [],
    }
    const ctx: ScanContext = { ...baseCtx(tmp.root, fake.exec), allProjects: [project] }
    const result = await provider.scanProject(project, ctx)
    expect(result.detected).toBe(false)
    expect(result.artifacts).toEqual([])
    expect(result.summary).toEqual([{ label: '○ Not a Git repository', status: 'info' }])
    expect(fake.calls).toHaveLength(0)
  })

  it('scanProject reports a missing git binary as a warning for repositories', async () => {
    const provider = createGitProvider()
    const project: ProjectDescriptor = {
      id: 'p1',
      name: 'repo',
      originalPath: tmp.root,
      canonicalPath: tmp.root,
      realPath: tmp.root,
      git: {
        root: tmp.root,
        remotes: [],
        head: null,
        branch: 'main',
        detached: false,
        isLinkedWorktree: false,
        worktrees: [],
      },
      detectedProviders: [],
    }
    const ctx: ScanContext = { ...baseCtx(tmp.root, gitMissingExec), allProjects: [project] }
    const result = await provider.scanProject(project, ctx)
    expect(result.detected).toBe(true)
    expect(result.artifacts).toEqual([])
    expect(result.warnings[0]).toMatch(/git is not installed/)
  })

  it('planRestore fails preflight with a blocking check when git is missing', async () => {
    const provider = createGitProvider()
    const payloadRoot = path.join(tmp.root, 'payload')
    const providerDir = path.join(payloadRoot, 'projects', 'p1', 'git')
    await fs.mkdir(providerDir, { recursive: true })
    const repository: RepositoryJson = {
      schemaVersion: GIT_SCHEMA_VERSION,
      capturedAt: new Date().toISOString(),
      gitVersion: 'git version 2.44.0',
      primaryPath: '/Users/alice/demo',
      commonDir: '/Users/alice/demo/.git',
      head: 'a'.repeat(40),
      branch: 'main',
      detached: false,
      bundle: { included: true, file: 'repo.bundle', sizeBytes: 3 },
      remotes: [{ name: 'origin', fetchUrl: 'https://example.com/demo.git' }],
      upstreams: { main: { remote: 'origin', merge: 'refs/heads/main' } },
      worktrees: [
        {
          index: 0,
          path: '/Users/alice/demo',
          branch: 'main',
          head: 'a'.repeat(40),
          detached: false,
          isPrimary: true,
          locked: false,
          prunable: false,
          captured: false,
        },
      ],
      stashCount: 0,
      hasSubmodules: false,
    }
    await fs.writeFile(path.join(providerDir, 'repository.json'), JSON.stringify(repository))
    await fs.writeFile(path.join(providerDir, 'repo.bundle'), 'xxx')
    const artifacts: ManifestArtifact[] = [
      {
        id: 'git:p1:bundle',
        providerId: 'git',
        kind: 'derived',
        label: 'Repository (all branches, tags)',
        payloadPath: 'projects/p1/git/repo.bundle',
        sizeBytes: 3,
        sensitivity: 'safe',
        meta: {
          kind: 'bundle',
          primaryPath: '/Users/alice/demo',
          repositoryJson: 'projects/p1/git/repository.json',
        },
      },
    ]
    const destination = path.join(tmp.root, 'dest', 'demo')
    const ctx: RestorePlanningContext = {
      ...baseCtx(tmp.root, gitMissingExec),
      payloadRoot,
      mappings: [{ projectId: 'p1', oldPath: '/Users/alice/demo', newPath: destination }],
      mapPath: (p) => ({ newPath: p, changed: false, mapped: false }),
      defaultCollisionPolicy: 'skip',
      restoreHints: {},
    }
    const plan = await provider.planRestore(
      {
        project: { id: 'p1', name: 'demo', oldPath: '/Users/alice/demo', newPath: destination },
        section: { providerId: 'git', schemaVersion: GIT_SCHEMA_VERSION, artifacts, summary: {} },
        artifacts,
      },
      ctx,
    )
    const check = plan.preflight.find((c) => c.id === 'git-installed')
    expect(check).toMatchObject({ status: 'fail', blocking: true })
    expect(check?.detail).toContain('GIT_NOT_INSTALLED')
    expect(plan.collisions).toEqual([])
    expect(plan.steps.map((s) => s.id)).toEqual(['repository'])
    expect(backupAsidePathsFrom(plan.state)).toEqual([])
  })

  it('planRestore rejects malformed branch names and shas from a tampered payload', async () => {
    const provider = createGitProvider()
    const payloadRoot = path.join(tmp.root, 'payload')
    const providerDir = path.join(payloadRoot, 'projects', 'p1', 'git')
    await fs.mkdir(providerDir, { recursive: true })
    const repository: RepositoryJson = {
      schemaVersion: GIT_SCHEMA_VERSION,
      capturedAt: new Date().toISOString(),
      gitVersion: null,
      primaryPath: '/Users/alice/demo',
      commonDir: null,
      head: 'nothex',
      branch: '-evil',
      detached: false,
      bundle: { included: true, file: 'repo.bundle', sizeBytes: 3 },
      remotes: [{ name: 'origin', fetchUrl: 'ext::sh -c evil' }],
      upstreams: {},
      worktrees: [
        {
          index: 1,
          path: '/Users/alice/demo-wt',
          branch: 'a..b',
          head: 'b'.repeat(40),
          detached: false,
          isPrimary: false,
          locked: false,
          prunable: false,
          captured: false,
        },
      ],
      stashCount: 0,
      hasSubmodules: false,
    }
    await fs.writeFile(path.join(providerDir, 'repository.json'), JSON.stringify(repository))
    await fs.writeFile(path.join(providerDir, 'repo.bundle'), 'xxx')
    const artifacts: ManifestArtifact[] = [
      {
        id: 'git:p1:bundle',
        providerId: 'git',
        kind: 'derived',
        label: 'Repository (all branches, tags)',
        payloadPath: 'projects/p1/git/repo.bundle',
        sizeBytes: 3,
        sensitivity: 'safe',
        meta: { kind: 'bundle', primaryPath: '/Users/alice/demo' },
      },
    ]
    const fake = createFakeExec([
      { match: matchCommand('git', '--version'), result: { stdout: 'git version 2.44.0\n' } },
      {
        match: matchCommand('git', 'bundle', 'list-heads'),
        result: { stdout: 'abc refs/heads/main\n' },
      },
      { match: matchCommand('git', 'check-ref-format'), result: { stdout: '' } },
    ])
    const destination = path.join(tmp.root, 'dest', 'demo')
    const ctx: RestorePlanningContext = {
      ...baseCtx(tmp.root, fake.exec),
      payloadRoot,
      mappings: [],
      mapPath: (p) => ({ newPath: p, changed: false, mapped: false }),
      defaultCollisionPolicy: 'skip',
      restoreHints: {},
    }
    const plan = await provider.planRestore(
      {
        project: { id: 'p1', name: 'demo', oldPath: '/Users/alice/demo', newPath: destination },
        section: { providerId: 'git', schemaVersion: GIT_SCHEMA_VERSION, artifacts, summary: {} },
        artifacts,
      },
      ctx,
    )
    const failures = plan.preflight.filter((c) => c.status === 'fail' && c.blocking)
    expect(failures.map((c) => c.id).sort()).toEqual(['branch:-evil', 'branch:a..b', 'head'])
    // '-evil' and 'a..b' must be rejected locally: git check-ref-format is never invoked for them.
    expect(fake.callsMatching(matchCommand('git', 'check-ref-format'))).toHaveLength(0)
    expect(plan.warnings.some((w) => w.includes('Remote "origin"'))).toBe(true)
  })
})
