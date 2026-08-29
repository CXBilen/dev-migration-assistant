/**
 * End-to-end round trips with real git in temp directories:
 * fake Mac A (/Users/alice/Documents/GitHub/demo) → scan → backup → plan → restore → verify on
 * fake Mac B (/Users/bob/Developer/demo), plus detached HEAD, empty repository, collisions, hooks,
 * cancellation and secret handling.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  BackupContext,
  MigrationProvider,
  ProviderRestoreInput,
  ProviderRestorePlan,
  ProviderRestoreResult,
  RestoreContext,
  RestorePlanningContext,
  ScanContext,
  VerifyContext,
} from '@devmig/core'
import type {
  CollisionPolicy,
  ManifestArtifact,
  PathMapping,
  ProjectDescriptor,
  ProviderScanResult,
} from '@devmig/model'
import {
  MigrationError,
  ScopedFs,
  canonicalizePath,
  noopLogger,
  realExec,
  stableId,
  walkFiles,
  type Exec,
} from '@devmig/shared'
import {
  bindExecEnv,
  captureGitState,
  compareGitState,
  createDetachedHeadRepo,
  createEmptyRepo,
  createFakeHome,
  createGitRepoFixture,
  fixtureBinary,
  makeTempRoot,
  type GitRepoFixture,
  type TempRoot,
} from '@devmig/test-utils'
import { createGitProvider } from './git-provider'
import { createGitClient, inspectRepository } from './git'
import { backupAsidePathsFrom } from './plan'
import { PlanState, RestoreState } from './schema'

const SECRET_TOKEN_LINE = 'API_KEY=sk-test-untracked-abcdef1234567890'

interface Harness {
  tmp: TempRoot
  provider: MigrationProvider
  counter: number
}

function baseCtx(
  homeDir: string,
  exec: Exec,
  env: Record<string, string | undefined>,
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    homeDir,
    claudeConfigDir: path.join(homeDir, '.claude'),
    claudeJsonPath: path.join(homeDir, '.claude.json'),
    env,
    exec,
    logger: noopLogger,
    signal,
    progress: () => {},
  }
}

/** Prefix-aware mapper mirroring core's PathRemapper semantics (longest prefix wins). */
function createMapper(mappings: PathMapping[]) {
  const sorted = [...mappings].sort((a, b) => b.oldPath.length - a.oldPath.length)
  return (oldPath: string): { newPath: string; changed: boolean; mapped: boolean } => {
    const canonical = canonicalizePath(oldPath)
    for (const m of sorted) {
      if (canonical === m.oldPath) {
        return { newPath: m.newPath, changed: m.newPath !== canonical, mapped: true }
      }
      if (canonical.startsWith(m.oldPath + path.sep)) {
        const mapped = path.join(m.newPath, canonical.slice(m.oldPath.length + 1))
        return { newPath: mapped, changed: mapped !== canonical, mapped: true }
      }
    }
    return { newPath: oldPath, changed: false, mapped: false }
  }
}

async function describeProject(
  dir: string,
  exec: Exec,
  env: Record<string, string>,
): Promise<ProjectDescriptor> {
  const git = await inspectRepository(dir, createGitClient(exec, { env }))
  const descriptor: ProjectDescriptor = {
    id: stableId(dir),
    name: path.basename(dir),
    originalPath: dir,
    canonicalPath: dir,
    realPath: dir,
    detectedProviders: [],
  }
  if (git) descriptor.git = git
  return descriptor
}

async function scan(
  h: Harness,
  project: ProjectDescriptor,
  exec: Exec,
  env: Record<string, string>,
): Promise<ProviderScanResult> {
  const ctx: ScanContext = { ...baseCtx(h.tmp.root, exec, env), allProjects: [project] }
  return h.provider.scanProject(project, ctx)
}

function defaultSelection(result: ProviderScanResult): string[] {
  return result.artifacts
    .filter((a) => a.includedByDefault && a.selectable && a.sensitivity !== 'credential')
    .map((a) => a.id)
}

async function backup(
  h: Harness,
  project: ProjectDescriptor,
  result: ProviderScanResult,
  selectedIds: readonly string[],
  exec: Exec,
  env: Record<string, string>,
): Promise<{ payloadRoot: string; artifacts: ManifestArtifact[]; warnings: string[] }> {
  h.counter += 1
  const payloadRoot = path.join(h.tmp.root, `payload-${h.counter}`)
  const relDir = path.posix.join('projects', project.id, 'git')
  const providerDir = path.join(payloadRoot, ...relDir.split('/'))
  await fs.mkdir(providerDir, { recursive: true, mode: 0o700 })
  const tempDir = path.join(h.tmp.root, `backup-tmp-${h.counter}`)
  await fs.mkdir(tempDir, { recursive: true, mode: 0o700 })
  const artifacts = result.artifacts.filter((a) => selectedIds.includes(a.id))
  const ctx: BackupContext = {
    ...baseCtx(h.tmp.root, exec, env),
    stagingDir: providerDir,
    fs: new ScopedFs([providerDir]),
    payloadPathFor: (rel) => `${relDir}/${rel.split(path.sep).join('/')}`,
    tempDir,
  }
  const output = await h.provider.createBackupArtifacts({ project, artifacts, scan: result }, ctx)
  return { payloadRoot, artifacts: output.artifacts, warnings: output.warnings ?? [] }
}

interface PlanRun {
  plan: ProviderRestorePlan
  input: ProviderRestoreInput
  mapPath: ReturnType<typeof createMapper>
  mappings: PathMapping[]
  newPath: string
}

async function plan(
  h: Harness,
  payloadRoot: string,
  project: ProjectDescriptor,
  manifestArtifacts: ManifestArtifact[],
  selectedIds: readonly string[],
  mappings: PathMapping[],
  exec: Exec,
  env: Record<string, string>,
  defaultCollisionPolicy: CollisionPolicy = 'skip',
): Promise<PlanRun> {
  const mapPath = createMapper(mappings)
  const newPath = mapPath(project.realPath).newPath
  const section = {
    providerId: 'git',
    schemaVersion: 1,
    artifacts: manifestArtifacts,
    summary: {},
  }
  const artifacts = manifestArtifacts.filter((a) => selectedIds.includes(a.id))
  const input: ProviderRestoreInput = {
    project: { id: project.id, name: project.name, oldPath: project.realPath, newPath },
    section,
    artifacts,
  }
  const ctx: RestorePlanningContext = {
    ...baseCtx(h.tmp.root, exec, env),
    payloadRoot,
    mappings,
    mapPath,
    defaultCollisionPolicy,
    restoreHints: {},
  }
  return { plan: await h.provider.planRestore(input, ctx), input, mapPath, mappings, newPath }
}

async function restore(
  h: Harness,
  run: PlanRun,
  payloadRoot: string,
  roots: string[],
  exec: Exec,
  env: Record<string, string | undefined>,
  opts: { decisions?: Record<string, CollisionPolicy>; signal?: AbortSignal } = {},
): Promise<{ result: ProviderRestoreResult; verifyCtx: VerifyContext }> {
  h.counter += 1
  const tempDir = path.join(h.tmp.root, `restore-tmp-${h.counter}`)
  await fs.mkdir(tempDir, { recursive: true, mode: 0o700 })
  const ctx: RestoreContext = {
    ...baseCtx(h.tmp.root, exec, env, opts.signal),
    payloadRoot,
    mappings: run.mappings,
    mapPath: run.mapPath,
    fs: new ScopedFs(roots),
    collisionDecisions: opts.decisions ?? {},
    tempDir,
  }
  const result = await h.provider.restore(run.plan, run.input, ctx)
  const verifyCtx: VerifyContext = {
    ...baseCtx(h.tmp.root, exec, env),
    payloadRoot,
    mapPath: run.mapPath,
  }
  return { result, verifyCtx }
}

async function verify(h: Harness, run: PlanRun, result: ProviderRestoreResult, ctx: VerifyContext) {
  return h.provider.verify({ plan: run.plan, result, input: run.input }, ctx)
}

async function listFilesWithContent(root: string): Promise<{ rel: string; text: string }[]> {
  const out: { rel: string; text: string }[] = []
  for await (const entry of walkFiles(root)) {
    out.push({
      rel: entry.relativePath,
      text: (await fs.readFile(entry.absolutePath)).toString('latin1'),
    })
  }
  return out
}

async function expectNoSecrets(root: string, secrets: readonly string[]): Promise<void> {
  for (const file of await listFilesWithContent(root)) {
    for (const secret of secrets) {
      expect(file.text, `${file.rel} must not contain a secret`).not.toContain(secret)
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

describe('GitProvider round trip (real git)', () => {
  const h: Harness = {
    tmp: undefined as unknown as TempRoot,
    provider: createGitProvider(),
    counter: 0,
  }
  let fixture: GitRepoFixture
  let alice: Awaited<ReturnType<typeof createFakeHome>>
  let bob: Awaited<ReturnType<typeof createFakeHome>>
  let exec: Exec
  let env: Record<string, string>
  let project: ProjectDescriptor
  let mappings: PathMapping[]
  let destination: string
  let destinationWorktree: string
  let sourceHookMarker: string

  beforeEach(async () => {
    h.tmp = await makeTempRoot('devmig-git-it-')
    h.counter = 0
    alice = await createFakeHome(h.tmp.root, { userName: 'alice' })
    bob = await createFakeHome(h.tmp.root, { userName: 'bob' })
    fixture = await createGitRepoFixture({
      root: alice.projectsDir,
      name: 'demo',
      homeDir: alice.homeDir,
      withWorktree: true,
      withLocalChanges: true,
      withBinary: true,
      withIgnoredEnv: true,
    })
    env = fixture.env
    exec = realExec
    // Extra untracked files: an executable script (mode must survive) and a secret-looking file.
    await fs.mkdir(path.join(fixture.path, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(fixture.path, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', {
      mode: 0o755,
    })
    await fs.writeFile(path.join(fixture.path, 'notes', 'token.txt'), `${SECRET_TOKEN_LINE}\n`)
    // A hook in the SOURCE repository must never run (and never travel).
    sourceHookMarker = path.join(h.tmp.root, 'SOURCE_HOOK_RAN')
    const hooksDir = path.join(fixture.path, '.git', 'hooks')
    await fs.mkdir(hooksDir, { recursive: true })
    await fs.writeFile(
      path.join(hooksDir, 'post-checkout'),
      `#!/bin/sh\necho ran > "${sourceHookMarker}"\n`,
      { mode: 0o755 },
    )
    project = await describeProject(fixture.path, exec, env)
    destination = path.join(bob.homeDir, 'Developer', 'demo')
    destinationWorktree = path.join(bob.homeDir, 'Developer', 'demo-onboarding')
    mappings = [
      { projectId: project.id, oldPath: fixture.path, newPath: destination },
      { projectId: project.id, oldPath: fixture.worktree!.path, newPath: destinationWorktree },
    ]
    // The destination does not exist on Mac B: the provider creates it (ScopedFs allows creating a
    // not-yet-existing root). Tests that need a pre-existing destination create it themselves.
  })

  afterEach(async () => {
    await h.tmp.cleanup()
  })

  it('scans the repository, its worktree, ignored and sensitive entries', async () => {
    const result = await scan(h, project, exec, env)
    expect(result.detected).toBe(true)
    const byId = new Map(result.artifacts.map((a) => [a.id, a]))
    const bundle = byId.get(`git:${project.id}:bundle`)
    expect(bundle).toMatchObject({
      kind: 'derived',
      sensitivity: 'safe',
      includedByDefault: true,
      selectable: true,
    })
    expect(bundle?.label).toBe('Repository (all branches, tags)')
    expect(byId.get(`git:${project.id}:worktree:0:state`)).toMatchObject({
      kind: 'file-set',
      includedByDefault: true,
      count: 6,
    })
    expect(byId.get(`git:${project.id}:worktree:1:state`)).toMatchObject({
      kind: 'file-set',
      includedByDefault: true,
      count: 2,
    })
    const sensitive = byId.get(`git:${project.id}:worktree:0:untracked-sensitive`)
    expect(sensitive).toMatchObject({
      sensitivity: 'sensitive',
      includedByDefault: false,
      selectable: true,
      count: 1,
    })
    expect(sensitive?.reasons.join(' ')).toContain('notes/token.txt')
    const junk = result.artifacts.filter((a) => a.scope === 'ephemeral')
    expect(junk.map((a) => a.label)).toEqual(['node_modules/ (ignored, not sized)'])
    expect(junk[0]).toMatchObject({ selectable: false, includedByDefault: false })
    const ignored = result.artifacts.filter((a) => a.meta.kind === 'ignored')
    expect(ignored).toHaveLength(1)
    expect(ignored[0]).toMatchObject({
      sensitivity: 'sensitive',
      includedByDefault: false,
      selectable: true,
    })
    expect(ignored[0]?.label).toMatch(/^\.env\.local \(ignored, \d+ B\)$/)
    const labels = result.summary.map((s) => s.label)
    expect(labels).toContain('✓ repository')
    expect(labels).toContain(`✓ main @ ${fixture.head.slice(0, 7)}`)
    expect(labels).toContain('✓ 2 worktrees')
    expect(labels).toContain('! 5 modified files')
    expect(labels).toContain('✓ 4 untracked files')
    expect(labels).toContain('! 1 sensitive untracked file excluded by default')
    expect(labels).toContain('○ node_modules excluded')
    const serialized = JSON.stringify(result)
    for (const secret of [...fixture.secrets, 'sk-test-untracked'])
      expect(serialized).not.toContain(secret)
    expect(result.estimatedBytes).toBeGreaterThan(0)
  })

  it('round-trips repository, worktree and working-tree state to another user and path', async () => {
    const before = await captureGitState(fixture.path, exec, { env })
    const scanned = await scan(h, project, exec, env)
    const selected = defaultSelection(scanned)
    expect(selected).toEqual([
      `git:${project.id}:bundle`,
      `git:${project.id}:worktree:0:state`,
      `git:${project.id}:worktree:1:state`,
    ])

    const backed = await backup(h, project, scanned, selected, exec, env)
    expect(backed.artifacts.map((a) => a.id)).toEqual(selected)
    const providerDir = path.join(backed.payloadRoot, 'projects', project.id, 'git')
    expect(await exists(path.join(providerDir, 'repository.json'))).toBe(true)
    expect(await exists(path.join(providerDir, 'repo.bundle'))).toBe(true)
    expect(
      await exists(path.join(providerDir, 'worktrees', '0', 'untracked', 'notes', 'todo.md')),
    ).toBe(true)
    expect(
      await exists(path.join(providerDir, 'worktrees', '0', 'untracked', 'notes', 'token.txt')),
    ).toBe(false)
    expect(await exists(path.join(providerDir, 'worktrees', '0', 'untracked-sensitive'))).toBe(
      false,
    )
    expect(
      await exists(path.join(providerDir, 'worktrees', '1', 'untracked', 'notes', 'wt-scratch.md')),
    ).toBe(true)
    await expectNoSecrets(backed.payloadRoot, [...fixture.secrets, 'sk-test-untracked'])
    // Backup never mutates the source.
    const after = await captureGitState(fixture.path, exec, { env })
    expect(compareGitState(before, after)).toEqual({ equal: true, differences: [] })

    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      exec,
      env,
    )
    expect(planned.newPath).toBe(destination)
    expect(planned.plan.preflight.filter((c) => c.status === 'fail')).toEqual([])
    expect(planned.plan.preflight.find((c) => c.id === 'destination')).toMatchObject({
      status: 'pass',
      label: 'Destination does not exist yet (will be created)',
      detail: destination,
    })
    expect(planned.plan.collisions).toEqual([])
    expect(backupAsidePathsFrom(planned.plan.state)).toEqual([])
    expect(planned.plan.steps.map((s) => s.id)).toEqual([
      'repository',
      'worktrees',
      'worktree-state',
    ])
    expect(planned.plan.steps[0]?.destination).toBe(destination)
    expect(planned.plan.steps[1]?.label).toBe('Recreate 1 worktree')
    expect(planned.plan.steps[2]?.label).toBe('Apply working tree state (8 files)')
    expect(planned.plan.remap).toMatchObject({ safeRewriteCount: 1, unsupportedReferences: [] })
    const state = PlanState.parse(planned.plan.state)
    expect(state.worktrees.map((w) => w.newPath)).toEqual([destination, destinationWorktree])

    const { result, verifyCtx } = await restore(
      h,
      planned,
      backed.payloadRoot,
      [destination, destinationWorktree],
      exec,
      env,
    )
    expect(result.status).toBe('ok')
    expect(result.items.filter((i) => i.status === 'error')).toEqual([])
    const verification = await verify(h, planned, result, verifyCtx)
    expect(verification.checks.filter((c) => c.status !== 'pass')).toEqual([])
    expect(verification.checks.map((c) => c.id)).toEqual([
      'worktree:0:head',
      'worktree:0:branch',
      'worktree:0:status',
      'worktree:1:head',
      'worktree:1:branch',
      'worktree:1:status',
      'worktrees',
      'remotes',
    ])

    // Logical state equal, ignoring absolute paths and the deliberately excluded sensitive file.
    const restoredPrimary = await captureGitState(destination, exec, { env })
    expect(compareGitState(before, restoredPrimary, { ignorePaths: ['notes/token.txt'] })).toEqual({
      equal: true,
      differences: [],
    })
    const restoredWorktree = await captureGitState(destinationWorktree, exec, { env })
    expect(compareGitState(fixture.worktree!.expected, restoredWorktree)).toEqual({
      equal: true,
      differences: [],
    })

    // Files: binary bytes identical, untracked restored, executable bit kept, secrets absent.
    expect(await fs.readFile(path.join(destination, 'assets', 'logo.png'))).toEqual(
      fixtureBinary(0xbadf00d),
    )
    expect(await fs.readFile(path.join(destination, 'notes', 'todo.md'), 'utf8')).toBe(
      '- [ ] write tests\n',
    )
    expect(await fs.readFile(path.join(destination, 'src', 'index.ts'), 'utf8')).toBe(
      "export const greeting = 'hello, world'\n",
    )
    expect((await fs.stat(path.join(destination, 'scripts', 'run.sh'))).mode & 0o111).toBe(0o111)
    expect(await exists(path.join(destination, '.env.local'))).toBe(false)
    expect(await exists(path.join(destination, 'notes', 'token.txt'))).toBe(false)
    expect(await exists(path.join(destination, 'node_modules'))).toBe(false)
    expect(await fs.readFile(path.join(destinationWorktree, 'src', 'onboarding.ts'), 'utf8')).toBe(
      'export const onboarding = { steps: 4 }\n',
    )
    expect(
      await fs.readFile(path.join(destinationWorktree, 'notes', 'wt-scratch.md'), 'utf8'),
    ).toBe('worktree scratch\n')

    // Remotes and upstream tracking configuration.
    const destExec = bindExecEnv(exec, env)
    expect(
      (await destExec('git', ['remote', 'get-url', 'origin'], { cwd: destination })).stdout.trim(),
    ).toBe(fixture.remoteUrl)
    expect(
      (await destExec('git', ['config', 'branch.main.remote'], { cwd: destination })).stdout.trim(),
    ).toBe('origin')
    expect(
      (await destExec('git', ['config', 'branch.main.merge'], { cwd: destination })).stdout.trim(),
    ).toBe('refs/heads/main')
    expect(
      (
        await destExec('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: destination })
      ).stdout.trim(),
    ).toBe(fixture.head)
    expect(await exists(sourceHookMarker)).toBe(false)
    const restoredState = RestoreState.parse(result.state)
    expect(
      restoredState.worktrees.map((w) => [w.created, w.stateApplied, w.sensitiveRestored]),
    ).toEqual([
      [true, true, false],
      [true, true, false],
    ])
  })

  it('restores sensitive untracked files and ignored entries only when explicitly selected', async () => {
    const scanned = await scan(h, project, exec, env)
    const ignoredId = scanned.artifacts.find((a) => a.meta.kind === 'ignored')?.id
    const sensitiveId = `git:${project.id}:worktree:0:untracked-sensitive`
    expect(ignoredId).toBeDefined()
    const selected = [...defaultSelection(scanned), sensitiveId, ignoredId!]
    const backed = await backup(h, project, scanned, selected, exec, env)
    expect(backed.artifacts.map((a) => a.id).sort()).toEqual([...selected].sort())
    const providerDir = path.join(backed.payloadRoot, 'projects', project.id, 'git')
    expect(
      await exists(
        path.join(providerDir, 'worktrees', '0', 'untracked-sensitive', 'notes', 'token.txt'),
      ),
    ).toBe(true)
    const ignoredArtifact = backed.artifacts.find((a) => a.id === ignoredId)
    expect(ignoredArtifact).toMatchObject({ kind: 'file', sensitivity: 'sensitive' })
    expect(
      await fs.readFile(
        path.join(backed.payloadRoot, ...ignoredArtifact!.payloadPath.split('/')),
        'utf8',
      ),
    ).toContain(fixture.secrets[0])

    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      exec,
      env,
    )
    expect(planned.plan.preflight.filter((c) => c.status === 'fail')).toEqual([])
    expect(planned.plan.steps.map((s) => s.id)).toEqual([
      'repository',
      'worktrees',
      'worktree-state',
      'ignored',
    ])
    const { result, verifyCtx } = await restore(
      h,
      planned,
      backed.payloadRoot,
      [destination, destinationWorktree],
      exec,
      env,
    )
    expect(result.status).toBe('ok')
    const verification = await verify(h, planned, result, verifyCtx)
    expect(verification.checks.filter((c) => c.status !== 'pass')).toEqual([])
    expect(await fs.readFile(path.join(destination, 'notes', 'token.txt'), 'utf8')).toBe(
      `${SECRET_TOKEN_LINE}\n`,
    )
    expect(await fs.readFile(path.join(destination, '.env.local'), 'utf8')).toBe(
      await fs.readFile(fixture.files.envLocal!, 'utf8'),
    )
    const before = await captureGitState(fixture.path, exec, { env })
    const restored = await captureGitState(destination, exec, { env })
    expect(compareGitState(before, restored)).toEqual({ equal: true, differences: [] })
  })

  it('reports collisions for non-empty destinations and honours skip / backup-then-replace', async () => {
    const scanned = await scan(h, project, exec, env)
    const selected = defaultSelection(scanned)
    const backed = await backup(h, project, scanned, selected, exec, env)
    await fs.mkdir(destination, { recursive: true })
    await fs.writeFile(path.join(destination, 'keep.txt'), 'existing content\n')

    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      exec,
      env,
    )
    expect(planned.plan.collisions).toHaveLength(1)
    expect(planned.plan.collisions[0]).toMatchObject({
      kind: 'directory-exists',
      path: destination,
      allowedPolicies: ['skip', 'backup-then-replace'],
      policy: 'skip',
    })
    const collisionId = planned.plan.collisions[0]!.id

    // skip: nothing is written
    const skipped = await restore(
      h,
      planned,
      backed.payloadRoot,
      [destination, destinationWorktree],
      exec,
      env,
      {
        decisions: { [collisionId]: 'skip' },
      },
    )
    expect(skipped.result.status).toBe('skipped')
    expect(await exists(path.join(destination, '.git'))).toBe(false)
    expect(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe('existing content\n')
    expect(await exists(destinationWorktree)).toBe(false)
    const skippedVerification = await verify(h, planned, skipped.result, skipped.verifyCtx)
    expect(skippedVerification.checks).toEqual([
      expect.objectContaining({ id: 'skipped', status: 'warn' }),
    ])

    // an existing git repository is reported as such
    const destExec = bindExecEnv(exec, env)
    await destExec('git', ['init', '--quiet'], { cwd: destination })
    const rePlanned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      exec,
      env,
    )
    expect(rePlanned.plan.collisions[0]).toMatchObject({ kind: 'git-repo-exists', policy: 'skip' })

    // backup-then-replace: the existing directory is moved aside (when the aside path is approved)
    const asidePath = PlanState.parse(rePlanned.plan.state).backupAsidePath
    expect(asidePath.startsWith(`${destination}.devmig-backup-`)).toBe(true)
    // The engine reads the aside paths from the plan state to extend the approved roots.
    expect(backupAsidePathsFrom(rePlanned.plan.state)).toEqual([asidePath])
    expect(backupAsidePathsFrom(planned.plan.state)).toEqual([
      PlanState.parse(planned.plan.state).backupAsidePath,
    ])
    const replaced = await restore(
      h,
      rePlanned,
      backed.payloadRoot,
      [destination, destinationWorktree, asidePath],
      exec,
      env,
      { decisions: { [rePlanned.plan.collisions[0]!.id]: 'backup-then-replace' } },
    )
    expect(replaced.result.status).toBe('ok')
    expect(await fs.readFile(path.join(asidePath, 'keep.txt'), 'utf8')).toBe('existing content\n')
    expect(await exists(path.join(destination, 'keep.txt'))).toBe(false)
    const verification = await verify(h, rePlanned, replaced.result, replaced.verifyCtx)
    expect(verification.checks.filter((c) => c.status !== 'pass')).toEqual([])
  })

  it('restores the whole repository when the selected project is a linked worktree', async () => {
    const worktreeProject = await describeProject(fixture.worktree!.path, exec, env)
    expect(worktreeProject.git?.isLinkedWorktree).toBe(true)
    const scanned = await scan(h, worktreeProject, exec, env)
    const selected = defaultSelection(scanned)
    // Index 0 is always the primary worktree, even though the user selected the linked one.
    expect(selected).toEqual([
      `git:${worktreeProject.id}:bundle`,
      `git:${worktreeProject.id}:worktree:0:state`,
      `git:${worktreeProject.id}:worktree:1:state`,
    ])
    expect(scanned.artifacts.find((a) => a.meta.kind === 'worktree-state')?.meta).toMatchObject({
      worktreeIndex: 0,
      path: fixture.path,
      isPrimary: true,
    })
    const backed = await backup(h, worktreeProject, scanned, selected, exec, env)
    // Core maps the selected directory and derives the sibling mapping for the primary worktree.
    const worktreeMappings: PathMapping[] = [
      {
        projectId: worktreeProject.id,
        oldPath: fixture.worktree!.path,
        newPath: destinationWorktree,
      },
      { projectId: worktreeProject.id, oldPath: fixture.path, newPath: destination },
    ]
    const planned = await plan(
      h,
      backed.payloadRoot,
      worktreeProject,
      backed.artifacts,
      selected,
      worktreeMappings,
      exec,
      env,
    )
    expect(planned.newPath).toBe(destinationWorktree)
    expect(planned.plan.preflight.filter((c) => c.status === 'fail')).toEqual([])
    expect(planned.plan.collisions).toEqual([])
    expect(planned.plan.warnings.some((w) => w.includes('linked worktree'))).toBe(true)
    const state = PlanState.parse(planned.plan.state)
    expect(state.destination).toBe(destination)
    expect(state.worktrees.map((w) => [w.isPrimary, w.newPath, w.branch])).toEqual([
      [true, destination, 'main'],
      [false, destinationWorktree, fixture.featureBranch],
    ])
    expect(planned.plan.steps[0]).toMatchObject({ id: 'repository', destination })

    const { result, verifyCtx } = await restore(
      h,
      planned,
      backed.payloadRoot,
      [destinationWorktree, destination],
      exec,
      env,
    )
    expect(result.status).toBe('ok')
    expect(result.items.filter((i) => i.status === 'error')).toEqual([])
    const verification = await verify(h, planned, result, verifyCtx)
    expect(verification.checks.filter((c) => c.status !== 'pass')).toEqual([])
    const before = await captureGitState(fixture.path, exec, { env })
    const restoredPrimary = await captureGitState(destination, exec, { env })
    expect(compareGitState(before, restoredPrimary, { ignorePaths: ['notes/token.txt'] })).toEqual({
      equal: true,
      differences: [],
    })
    const restoredWorktree = await captureGitState(destinationWorktree, exec, { env })
    expect(compareGitState(fixture.worktree!.expected, restoredWorktree)).toEqual({
      equal: true,
      differences: [],
    })
    expect(await exists(sourceHookMarker)).toBe(false)
  })

  it('never runs repository hooks during restore', async () => {
    const marker = path.join(h.tmp.root, 'HOOK_RAN')
    const templateDir = path.join(h.tmp.root, 'git-template')
    await fs.mkdir(path.join(templateDir, 'hooks'), { recursive: true })
    for (const hook of [
      'post-checkout',
      'post-merge',
      'pre-applypatch',
      'reference-transaction',
      'post-index-change',
    ]) {
      await fs.writeFile(
        path.join(templateDir, 'hooks', hook),
        `#!/bin/sh\necho ${hook} >> "${marker}"\n`,
        { mode: 0o755 },
      )
    }
    const hookEnv = { ...env, GIT_TEMPLATE_DIR: templateDir }
    const scanned = await scan(h, project, exec, env)
    const selected = defaultSelection(scanned)
    const backed = await backup(h, project, scanned, selected, exec, env)
    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      exec,
      hookEnv,
    )
    const { result } = await restore(
      h,
      planned,
      backed.payloadRoot,
      [destination, destinationWorktree],
      exec,
      hookEnv,
    )
    expect(result.status).toBe('ok')
    // The template hooks were installed into the restored repository but never executed.
    expect(await exists(path.join(destination, '.git', 'hooks', 'post-checkout'))).toBe(true)
    expect(await exists(marker)).toBe(false)
    expect(await exists(sourceHookMarker)).toBe(false)
    // Control: without the hooks guard the very same hook fires.
    const destExec = bindExecEnv(exec, hookEnv)
    await destExec('git', ['checkout', '--quiet', '--detach', 'HEAD'], { cwd: destination })
    expect(await exists(marker)).toBe(true)
  })

  it('cancels mid-restore with CANCELLED and without running hooks', async () => {
    const marker = path.join(h.tmp.root, 'HOOK_RAN')
    const templateDir = path.join(h.tmp.root, 'git-template')
    await fs.mkdir(path.join(templateDir, 'hooks'), { recursive: true })
    await fs.writeFile(
      path.join(templateDir, 'hooks', 'post-checkout'),
      `#!/bin/sh\necho ran >> "${marker}"\n`,
      { mode: 0o755 },
    )
    const hookEnv = { ...env, GIT_TEMPLATE_DIR: templateDir }
    const scanned = await scan(h, project, exec, env)
    const selected = defaultSelection(scanned)
    const backed = await backup(h, project, scanned, selected, exec, env)
    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      exec,
      env,
    )

    const controller = new AbortController()
    const abortingExec: Exec = async (file, args, options) => {
      const result = await realExec(file, args, options)
      if (file === 'git' && args.includes('fetch')) controller.abort()
      return result
    }
    await expect(
      restore(
        h,
        planned,
        backed.payloadRoot,
        [destination, destinationWorktree],
        abortingExec,
        hookEnv,
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await exists(marker)).toBe(false)
    expect(await exists(destinationWorktree)).toBe(false)
  })

  it('keeps the repository and preserves diffs when a patch no longer applies', async () => {
    const scanned = await scan(h, project, exec, env)
    const selected = defaultSelection(scanned)
    const backed = await backup(h, project, scanned, selected, exec, env)
    // Tamper with the staged diff so that its hunk no longer matches the committed content.
    const stagedDiff = path.join(
      backed.payloadRoot,
      'projects',
      project.id,
      'git',
      'worktrees',
      '0',
      'staged.diff',
    )
    const original = await fs.readFile(stagedDiff, 'utf8')
    expect(original).toContain("-export const greeting = 'hello'")
    await fs.writeFile(
      stagedDiff,
      original.replace("-export const greeting = 'hello'", "-export const greeting = 'nope'"),
    )
    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      exec,
      env,
    )
    const { result, verifyCtx } = await restore(
      h,
      planned,
      backed.payloadRoot,
      [destination, destinationWorktree],
      exec,
      env,
    )
    expect(result.status).toBe('partial')
    const failed = result.items.find((i) => i.status === 'error')
    expect(failed?.label).toContain('GIT_APPLY_FAILED')
    expect(failed?.detail).toContain('.devmig-unapplied')
    expect(await exists(path.join(destination, '.devmig-unapplied', 'staged.diff'))).toBe(true)
    expect(await exists(path.join(destination, '.devmig-unapplied', 'unstaged.diff'))).toBe(true)
    // The repository itself is intact, untracked files were still restored, the worktree is fine.
    expect(
      (
        await bindExecEnv(exec, env)('git', ['rev-parse', 'HEAD'], { cwd: destination })
      ).stdout.trim(),
    ).toBe(fixture.head)
    expect(await fs.readFile(path.join(destination, 'notes', 'todo.md'), 'utf8')).toBe(
      '- [ ] write tests\n',
    )
    const verification = await verify(h, planned, result, verifyCtx)
    const status0 = verification.checks.find((c) => c.id === 'worktree:0:status')
    expect(status0?.status).toBe('fail')
    expect(status0?.detail).toContain('working-tree changes could not be applied')
    expect(verification.checks.find((c) => c.id === 'worktree:1:status')?.status).toBe('pass')
    expect(RestoreState.parse(result.state).worktrees[0]).toMatchObject({
      applyFailed: true,
      stateApplied: false,
    })
  })

  it('refuses to write outside the approved roots', async () => {
    const scanned = await scan(h, project, exec, env)
    const selected = defaultSelection(scanned)
    const backed = await backup(h, project, scanned, selected, exec, env)
    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      exec,
      env,
    )
    const elsewhere = path.join(h.tmp.root, 'elsewhere')
    await fs.mkdir(elsewhere, { recursive: true })
    await expect(
      restore(h, planned, backed.payloadRoot, [elsewhere], exec, env),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' })
    expect(await exists(path.join(destination, '.git'))).toBe(false)
  })
})

describe('GitProvider round trip: special repositories', () => {
  const h: Harness = {
    tmp: undefined as unknown as TempRoot,
    provider: createGitProvider(),
    counter: 0,
  }

  beforeEach(async () => {
    h.tmp = await makeTempRoot('devmig-git-it2-')
    h.counter = 0
  })
  afterEach(async () => {
    await h.tmp.cleanup()
  })

  it('round-trips a detached HEAD', async () => {
    const source = path.join(h.tmp.root, 'src')
    await fs.mkdir(source)
    const repo = await createDetachedHeadRepo({
      root: source,
      name: 'detached',
      homeDir: h.tmp.root,
    })
    const project = await describeProject(repo.path, realExec, repo.env)
    expect(project.git?.detached).toBe(true)
    const scanned = await scan(h, project, realExec, repo.env)
    expect(scanned.summary.map((s) => s.label)).toContain(
      `! detached HEAD @ ${repo.head!.slice(0, 7)}`,
    )
    const selected = defaultSelection(scanned)
    const backed = await backup(h, project, scanned, selected, realExec, repo.env)
    const destination = path.join(h.tmp.root, 'dest', 'detached')
    await fs.mkdir(destination, { recursive: true })
    const mappings = [{ projectId: project.id, oldPath: repo.path, newPath: destination }]
    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      realExec,
      repo.env,
    )
    expect(planned.plan.preflight.filter((c) => c.status === 'fail')).toEqual([])
    expect(planned.plan.steps[0]?.detail).toContain('detached HEAD')
    const { result, verifyCtx } = await restore(
      h,
      planned,
      backed.payloadRoot,
      [destination],
      realExec,
      repo.env,
    )
    expect(result.status).toBe('ok')
    const verification = await verify(h, planned, result, verifyCtx)
    expect(verification.checks.filter((c) => c.status !== 'pass')).toEqual([])
    const restored = await captureGitState(destination, realExec, { env: repo.env })
    expect(restored).toMatchObject({ head: repo.commits[0], branch: null, detached: true })
    expect(compareGitState(repo.expected, restored)).toEqual({ equal: true, differences: [] })
    const destExec = bindExecEnv(realExec, repo.env)
    // Both commits travelled (main still points at the second commit).
    expect(
      (await destExec('git', ['rev-parse', 'refs/heads/main'], { cwd: destination })).stdout.trim(),
    ).toBe(repo.commits[1])
  })

  it('round-trips an empty repository (no commits) with staged and untracked files', async () => {
    const source = path.join(h.tmp.root, 'src')
    await fs.mkdir(source)
    const repo = await createEmptyRepo({ root: source, name: 'empty', homeDir: h.tmp.root })
    await fs.writeFile(path.join(repo.path, 'staged.txt'), 'staged\n')
    await fs.writeFile(path.join(repo.path, 'loose.txt'), 'loose\n')
    await repo.exec('git', ['add', '--', 'staged.txt'], { cwd: repo.path })
    const expected = await captureGitState(repo.path, realExec, { env: repo.env })
    expect(expected.head).toBeNull()
    const project = await describeProject(repo.path, realExec, repo.env)
    const scanned = await scan(h, project, realExec, repo.env)
    expect(scanned.detected).toBe(true)
    expect(scanned.artifacts.find((a) => a.meta.kind === 'bundle')).toBeUndefined()
    expect(scanned.warnings.some((w) => w.includes('no commits'))).toBe(true)
    expect(scanned.summary.map((s) => s.label)).toContain('! no commits yet')
    const selected = defaultSelection(scanned)
    expect(selected).toEqual([`git:${project.id}:worktree:0:state`])
    const backed = await backup(h, project, scanned, selected, realExec, repo.env)
    const destination = path.join(h.tmp.root, 'dest', 'empty')
    await fs.mkdir(destination, { recursive: true })
    const mappings = [{ projectId: project.id, oldPath: repo.path, newPath: destination }]
    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      realExec,
      repo.env,
    )
    expect(planned.plan.preflight.filter((c) => c.status === 'fail')).toEqual([])
    expect(planned.plan.steps.map((s) => s.label)).toEqual([
      'Initialise empty repository',
      'Apply working tree state (2 files)',
    ])
    const { result, verifyCtx } = await restore(
      h,
      planned,
      backed.payloadRoot,
      [destination],
      realExec,
      repo.env,
    )
    expect(result.status).toBe('ok')
    const verification = await verify(h, planned, result, verifyCtx)
    expect(verification.checks.filter((c) => c.status !== 'pass')).toEqual([])
    const restored = await captureGitState(destination, realExec, { env: repo.env })
    expect(restored).toMatchObject({ head: null, branch: 'main' })
    expect(compareGitState(expected, restored)).toEqual({ equal: true, differences: [] })
    expect(await fs.readFile(path.join(destination, 'loose.txt'), 'utf8')).toBe('loose\n')
  })

  it('rejects malformed branch names in a tampered repository.json before running git', async () => {
    const source = path.join(h.tmp.root, 'src')
    await fs.mkdir(source)
    const repo = await createDetachedHeadRepo({ root: source, name: 'tamper', homeDir: h.tmp.root })
    const project = await describeProject(repo.path, realExec, repo.env)
    const scanned = await scan(h, project, realExec, repo.env)
    const selected = defaultSelection(scanned)
    const backed = await backup(h, project, scanned, selected, realExec, repo.env)
    const file = path.join(backed.payloadRoot, 'projects', project.id, 'git', 'repository.json')
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as {
      branch: string | null
      detached: boolean
    }
    json.branch = '-evil'
    json.detached = false
    await fs.writeFile(file, JSON.stringify(json))
    const destination = path.join(h.tmp.root, 'dest', 'tamper')
    await fs.mkdir(destination, { recursive: true })
    const mappings = [{ projectId: project.id, oldPath: repo.path, newPath: destination }]
    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      realExec,
      repo.env,
    )
    expect(
      planned.plan.preflight.some(
        (c) => c.id === 'branch:-evil' && c.status === 'fail' && c.blocking,
      ),
    ).toBe(true)
    // Even if the plan were executed anyway, restore refuses the name.
    await expect(
      restore(h, planned, backed.payloadRoot, [destination], realExec, repo.env),
    ).rejects.toBeInstanceOf(MigrationError)
  })

  it('round-trips hostile file and branch names without executing them', async () => {
    const source = path.join(h.tmp.root, 'src')
    await fs.mkdir(source)
    // Escapes, not literals: an editor or formatter that normalises the source file would silently
    // collapse the pair into two identical names and the assertion below would prove nothing.
    const nfc = 'caf\u00e9.txt' // precomposed: LATIN SMALL LETTER E WITH ACUTE
    const nfd = 'cafe\u0301.txt' // decomposed: 'e' + COMBINING ACUTE ACCENT
    const committed = ['-rf.txt', 'qu"ote\'.txt', 'back\\slash.txt', nfc, nfd]
    const untracked = ['line\nbreak.txt']
    const ignored = ['-ignored-secret.txt']
    const hostileBranch = 'feat/weird--name'
    const fixture = await createGitRepoFixture({
      root: source,
      name: 'hostile',
      homeDir: h.tmp.root,
      withWorktree: false,
      withBinary: false,
      withIgnoredEnv: false,
      hostileNames: { committed, untracked, ignored },
    })
    expect(fixture.hostilePaths).toEqual({ committed, untracked, ignored })
    // No leading '-', so it can never be read as an option; still one whole argv element.
    await fixture.exec('git', ['branch', hostileBranch], { cwd: fixture.path })
    // A hook in the SOURCE repository must never run during scan, backup or restore.
    const hookMarker = path.join(h.tmp.root, 'HOSTILE_HOOK_RAN')
    const hooksDir = path.join(fixture.path, '.git', 'hooks')
    await fs.mkdir(hooksDir, { recursive: true })
    await fs.writeFile(
      path.join(hooksDir, 'post-checkout'),
      `#!/bin/sh\necho ran > "${hookMarker}"\n`,
      { mode: 0o755 },
    )

    // Record every argv the provider hands to a subprocess.
    const seenArgv: { file: string; args: string[] }[] = []
    const recording: Exec = (file, args, options) => {
      seenArgv.push({ file, args: [...args] })
      return realExec(file, args, options)
    }

    // The pre-migration snapshot is taken here, not through `refreshGitFixtureExpectations`:
    // nothing below reads `fixture.expected`, and a refresh would re-run the same six git calls
    // for a value no assertion touches.
    const before = await captureGitState(fixture.path, realExec, { env: fixture.env })
    const project = await describeProject(fixture.path, recording, fixture.env)
    const scanned = await scan(h, project, recording, fixture.env)
    expect(scanned.detected).toBe(true)
    const selected = defaultSelection(scanned)
    const backed = await backup(h, project, scanned, selected, recording, fixture.env)
    const destination = path.join(h.tmp.root, 'dest', 'hostile')
    await fs.mkdir(destination, { recursive: true })
    const mappings = [{ projectId: project.id, oldPath: fixture.path, newPath: destination }]
    const planned = await plan(
      h,
      backed.payloadRoot,
      project,
      backed.artifacts,
      selected,
      mappings,
      recording,
      fixture.env,
    )
    expect(planned.plan.preflight.filter((c) => c.status === 'fail')).toEqual([])
    const { result, verifyCtx } = await restore(
      h,
      planned,
      backed.payloadRoot,
      [destination],
      recording,
      fixture.env,
    )
    expect(result.status).toBe('ok')
    expect(result.items.filter((i) => i.status === 'error')).toEqual([])
    const verification = await verify(h, planned, result, verifyCtx)
    expect(verification.checks.filter((c) => c.status !== 'pass')).toEqual([])

    // Byte-identical content at every hostile path the source really had.
    const sourceNames = await fs.readdir(fixture.path)
    const restoredNames = await fs.readdir(destination)
    // Every name but the NFC/NFD pair must really be on disk, or the loop below proves nothing.
    for (const name of [...committed, ...untracked].filter((n) => n.normalize('NFC') !== nfc)) {
      expect(sourceNames, `source ${JSON.stringify(name)}`).toContain(name)
    }
    for (const name of [...committed, ...untracked]) {
      if (!sourceNames.includes(name)) continue // see the NFC/NFD assertion below
      expect(restoredNames, `restored ${JSON.stringify(name)}`).toContain(name)
      expect(await fs.readFile(path.join(destination, name))).toEqual(
        await fs.readFile(path.join(fixture.path, name)),
      )
    }
    // The NFC/NFD pair either produced two entries or the filesystem folded them into one. Both are
    // acceptable; what is not acceptable is the restore producing a different set than the source.
    const cafeSource = sourceNames.filter((n) => n.normalize('NFC') === nfc).sort()
    const cafeRestored = restoredNames.filter((n) => n.normalize('NFC') === nfc).sort()
    expect(cafeSource.length, 'the NFC/NFD pair produced no entry at all').toBeGreaterThan(0)
    expect(cafeRestored).toEqual(cafeSource)
    // Ignored entries belong to the project-files provider and are not restored by git.
    expect(restoredNames).not.toContain(ignored[0])

    // Logical git state is equivalent, and the hostile branch travelled in the bundle.
    const restored = await captureGitState(destination, realExec, { env: fixture.env })
    expect(compareGitState(before, restored)).toEqual({ equal: true, differences: [] })
    const destExec = bindExecEnv(realExec, fixture.env)
    const refAt = async (cwd: string): Promise<string> =>
      (
        await destExec('git', ['rev-parse', '--verify', `refs/heads/${hostileBranch}`], { cwd })
      ).stdout.trim()
    expect(await refAt(destination)).toBe(await refAt(fixture.path))

    // No hook ran, on either side.
    expect(await exists(hookMarker)).toBe(false)

    // Option-injection guard: a name starting with '-' may only appear after a `--` separator.
    for (const call of seenArgv) {
      for (const [i, arg] of call.args.entries()) {
        if (!arg.startsWith('-') || (arg !== '-rf.txt' && arg !== ignored[0])) continue
        expect(
          call.args.slice(0, i),
          `${call.file} ${JSON.stringify(call.args)} passes ${arg} without a -- separator`,
        ).toContain('--')
      }
    }
    // That loop is a guard for future changes, and today it is deliberately empty: the provider
    // never names a working-tree file on a command line at all (bundle + diffs + `status -z`;
    // untracked files are copied through Node fs), so no hostile name ever reaches argv. Pinned
    // here so the loop above cannot go quietly vacuous if that ever stops being true.
    expect(seenArgv.filter((c) => c.args.some((a) => a === '-rf.txt' || a === ignored[0]))).toEqual(
      [],
    )
  })
})
