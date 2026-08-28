/**
 * Definition-of-Done migration test (spec §42).
 *
 * Drives the WHOLE pipeline through the real providers, the real .devbackup archive and the real
 * JobManager — exactly the way the Electron main process will: scan → defaultSelection → backup (job)
 * → readHeader/inspect → plan (job) → execute (job) → verify. Nothing here is faked: real `git`, real
 * files under os.tmpdir(), real AES-256-GCM/Argon2id container.
 *
 * Mac A (alice) is a dirty demo repo with a sibling worktree, Claude Code sessions/settings/memory and
 * a local .env.local; Mac B (bob) starts with an empty ~/.claude. The scenarios prove the source is
 * never mutated, the restore is logically equivalent under a changed username/path, opt-in secrets
 * round-trip, and re-restores/cancellation stay non-destructive.
 *
 * The backup engine passes no `kdf` to the archive (BackupRequest has no such field), so the strong
 * default Argon2id preset is used; only two backups are created to keep this well under ~90 s.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  BackupResult,
  Manifest,
  PathMapping,
  RestorePlan,
  RestoreResult,
  ScanSession,
  ScannedArtifact,
} from '@devmig/model'
import { noopLogger, pathExists, realExec, walkFiles } from '@devmig/shared'
import { createClaudeCodeProvider } from '../../providers/claude-code/src/index'
import { createGitProvider } from '../../providers/git/src/index'
import { createProjectFilesProvider } from '../../providers/project-files/src/index'
import { createRuntimeProvider } from '../../providers/runtime/src/index'
import {
  FIXTURE_CLAUDE_VERSION,
  FIXTURE_FILE_HISTORY_BLOBS,
  FIXTURE_MCP_SECRET,
  captureGitState,
  compareGitState,
  createDestinationMachineFixture,
  createSourceMachineFixture,
  encodeClaudeProjectDir,
  gitTestEnv,
  makeTempRoot,
  readJsonl,
  type DestinationMachineFixture,
  type FakeHome,
  type SourceMachineFixture,
  type TempRoot,
} from '../../test-utils/src/index'
import type { CoreServices } from './api'
import { createCoreServices } from './create-core-services'
import type { Environment } from './environment'
import type { JobRunContext } from './jobs/job-manager'
import { defaultSelection } from './migration/planner'
import type { JobKind } from '@devmig/model'
import { ProviderRegistry } from './providers/registry'

const PASSWORD = 'correct horse battery staple'

// ---------------------------------------------------------------- helpers

/** An Environment for a fixture home: real git/exec with a deterministic git env, CLAUDE_CONFIG_DIR unset. */
function makeEnv(home: FakeHome): Environment {
  return {
    homeDir: home.homeDir,
    claudeConfigDir: home.claudeConfigDir,
    claudeJsonPath: home.claudeJsonPath,
    env: { ...home.env, ...gitTestEnv(home.homeDir), CLAUDE_CONFIG_DIR: undefined },
    exec: realExec,
    logger: noopLogger,
  }
}

/** Real providers, real archive, in the fixed restore order git → project-files → claude-code → runtime. */
function makeServices(env: Environment, workDir: string): CoreServices {
  const registry = new ProviderRegistry()
    .register(createGitProvider())
    .register(createProjectFilesProvider())
    .register(createClaudeCodeProvider())
    .register(createRuntimeProvider())
  return createCoreServices({ env, registry, appVersion: 'test', workDir })
}

/** Run a unit of work through the JobManager exactly like the Electron main process does. */
async function runJob<T>(
  services: CoreServices,
  kind: JobKind,
  runner: (ctx: JobRunContext) => Promise<T>,
): Promise<T> {
  const snap = services.jobs.start(kind, runner)
  return services.jobs.result<T>(snap.id)
}

function scanArtifacts(scan: ScanSession): ScannedArtifact[] {
  return [
    ...scan.projects.flatMap((p) => p.providers.flatMap((s) => s.artifacts)),
    ...scan.global.flatMap((s) => s.artifacts),
  ]
}

function allArtifactIds(manifest: Manifest): string[] {
  return [
    ...manifest.projects.flatMap((p) => p.providers.flatMap((s) => s.artifacts.map((a) => a.id))),
    ...manifest.global.flatMap((s) => s.artifacts.map((a) => a.id)),
  ]
}

function metaField(artifact: ScannedArtifact, key: string): unknown {
  return artifact.meta[key]
}

/** Content-addressed hash of a directory tree (relative path + bytes; ignores mtimes/permissions). */
async function hashTree(dir: string): Promise<string> {
  const entries: { rel: string; data: Buffer }[] = []
  for await (const e of walkFiles(dir)) {
    if (!e.dirent.isFile()) continue
    entries.push({ rel: e.relativePath, data: await fs.readFile(e.absolutePath) })
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const h = createHash('sha256')
  for (const e of entries) {
    h.update(e.rel)
    h.update('\0')
    h.update(e.data)
  }
  return h.digest('hex')
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

/** Safely walks nested object keys; returns undefined at the first non-object. */
function dig(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) {
    if (cur !== null && typeof cur === 'object') cur = (cur as Record<string, unknown>)[k]
    else return undefined
  }
  return cur
}

async function listSessionIds(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  return names
    .filter((n) => n.endsWith('.jsonl') && !n.includes('.devmig-'))
    .map((n) => n.replace(/\.jsonl$/, ''))
    .sort()
}

// ---------------------------------------------------------------- shared state

let tmp: TempRoot
let source: SourceMachineFixture
let servicesA: CoreServices
let scanA: ScanSession
let defSel: string[]
let envLocalId: string
let mcpEnvId: string

let backupPathA: string
let manifestA: Manifest

let destB: DestinationMachineFixture
let servicesB: CoreServices
let newDemoB: string
let mappingB: PathMapping[]

const disposables: CoreServices[] = []

beforeAll(async () => {
  tmp = await makeTempRoot('devmig-dod-')
  source = await createSourceMachineFixture(path.join(tmp.root, 'macA'))
  servicesA = makeServices(makeEnv(source.home), path.join(tmp.root, 'workA'))
  disposables.push(servicesA)

  destB = await createDestinationMachineFixture(path.join(tmp.root, 'macB'))
  servicesB = makeServices(makeEnv(destB.home), path.join(tmp.root, 'workB'))
  disposables.push(servicesB)
  newDemoB = path.join(destB.home.homeDir, 'Developer', 'demo')

  scanA = await runJob<ScanSession>(servicesA, 'scan', (ctx) =>
    servicesA.scanner.scan([source.projectPath], { includeGlobal: true }, ctx),
  )
})

afterAll(async () => {
  for (const s of disposables) await s.dispose().catch(() => undefined)
  await tmp.cleanup()
})

describe('Definition of Done: Mac A (alice) → Mac B (bob)', () => {
  it('scan (Scenario A defaults): detects the expected artifacts with the right defaults', () => {
    const arts = scanArtifacts(scanA)

    // git: bundle + working-tree state (primary + linked worktree)
    expect(arts.some((a) => a.providerId === 'git' && metaField(a, 'kind') === 'bundle')).toBe(true)
    expect(
      arts.filter((a) => a.providerId === 'git' && metaField(a, 'kind') === 'worktree-state')
        .length,
    ).toBeGreaterThanOrEqual(2)

    // claude-code: sessions ON by default, memory, project claude.json entry
    const sessions = arts.filter(
      (a) => a.providerId === 'claude-code' && metaField(a, 'artifactKind') === 'sessions',
    )
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions.every((a) => a.includedByDefault && a.sensitivity === 'safe')).toBe(true)
    expect(
      arts.some(
        (a) =>
          a.providerId === 'claude-code' &&
          metaField(a, 'artifactKind') === 'memory' &&
          a.includedByDefault,
      ),
    ).toBe(true)
    expect(
      arts.some(
        (a) =>
          a.providerId === 'claude-code' &&
          metaField(a, 'artifactKind') === 'claude-json-project' &&
          a.includedByDefault,
      ),
    ).toBe(true)

    // claude-code project-side files carried out of band of Git
    const projFiles = arts.filter(
      (a) => a.providerId === 'claude-code' && metaField(a, 'artifactKind') === 'project-file',
    )
    expect(
      projFiles.some((a) => metaField(a, 'relativePath') === '.claude/settings.local.json'),
    ).toBe(true)
    expect(projFiles.some((a) => metaField(a, 'relativePath') === 'CLAUDE.local.md')).toBe(true)

    // runtime present
    expect(arts.some((a) => a.providerId === 'runtime')).toBe(true)

    // sensitive, opt-in artifacts present but OFF by default
    const envLocal = arts.find(
      (a) => a.providerId === 'project-files' && metaField(a, 'relpath') === '.env.local',
    )
    expect(envLocal).toBeDefined()
    expect(envLocal!.includedByDefault).toBe(false)
    const mcpEnv = arts.find(
      (a) =>
        a.providerId === 'claude-code' && metaField(a, 'artifactKind') === 'claude-json-mcp-env',
    )
    expect(mcpEnv).toBeDefined()
    expect(mcpEnv!.includedByDefault).toBe(false)
    envLocalId = envLocal!.id
    mcpEnvId = mcpEnv!.id

    defSel = defaultSelection(scanA)
    expect(defSel).not.toContain(envLocalId)
    expect(defSel).not.toContain(mcpEnvId)
  })

  it('backup (Scenario A): writes a verified .devbackup and never mutates the source', async () => {
    const gitBefore = await captureGitState(source.projectPath, realExec, { env: source.repo.env })
    const claudeHashBefore = await hashTree(source.home.claudeConfigDir)
    const jsonBefore = await fs.readFile(source.home.claudeJsonPath)

    backupPathA = path.join(tmp.root, 'A.devbackup')
    const result = await runJob<BackupResult>(servicesA, 'backup', (ctx) =>
      servicesA.backup.run(
        {
          scanId: scanA.id,
          selectedArtifactIds: defSel,
          outputPath: backupPathA,
          password: PASSWORD,
          label: 'Mac A',
        },
        ctx,
      ),
    )
    manifestA = result.manifest

    expect(await pathExists(backupPathA)).toBe(true)
    expect((await fs.stat(backupPathA)).size).toBeGreaterThan(0)
    expect(result.verified).toBe(true)

    // Independent whole-file verification of the container.
    const verified = await runJob(servicesB, 'verify', (ctx) =>
      servicesB.restore.verify(backupPathA, PASSWORD, ctx),
    )
    expect(verified.ok).toBe(true)
    expect(verified.entries).toBeGreaterThan(0)

    // Manifest stats.
    expect(manifestA.stats.projectCount).toBe(1)
    expect(manifestA.stats.claudeSessionCount).toBe(source.claude.expectedProjectSessionIds.length)
    expect(manifestA.stats.worktreeCount).toBe(1)

    // Capability snapshot: the real claude-code provider's transcript-writer-version summary
    // reaches manifest.capabilities.claude.transcriptWriterVersions (spec §5.3 / Task 7).
    expect(manifestA.capabilities?.role).toBe('source')
    expect(manifestA.capabilities?.claude.transcriptWriterVersions).toContain(
      FIXTURE_CLAUDE_VERSION,
    )

    // The source is byte-for-byte unchanged.
    expect(
      compareGitState(
        gitBefore,
        await captureGitState(source.projectPath, realExec, { env: source.repo.env }),
      ).differences,
    ).toEqual([])
    expect(await hashTree(source.home.claudeConfigDir)).toBe(claudeHashBefore)
    expect((await fs.readFile(source.home.claudeJsonPath)).equals(jsonBefore)).toBe(true)
  })

  it('inspect (Scenario A): header + manifest are readable and password-gated', async () => {
    const header = await servicesB.restore.readHeader(backupPathA)
    expect(header).toMatchObject({ supported: true, cipher: 'aes-256-gcm' })
    expect(header.kdf.algorithm).toBe('argon2id')

    const inspection = await runJob(servicesB, 'inspect', (ctx) =>
      servicesB.restore.inspect(backupPathA, PASSWORD, ctx),
    )
    expect(inspection.manifest.id).toBe(manifestA.id)

    await expect(
      runJob(servicesB, 'inspect', (ctx) =>
        servicesB.restore.inspect(backupPathA, 'wrong password', ctx),
      ),
    ).rejects.toMatchObject({ code: 'ARCHIVE_AUTH_FAILED' })
  })

  it('plan (Scenario A): a clean restore into Mac B with the worktree following the project', async () => {
    mappingB = [
      { projectId: manifestA.projects[0]!.id, oldPath: source.projectPath, newPath: newDemoB },
    ]
    const plan = await runJob<RestorePlan>(servicesB, 'restore-plan', (ctx) =>
      servicesB.restore.plan(
        {
          backupPath: backupPathA,
          password: PASSWORD,
          mappings: mappingB,
          selectedArtifactIds: allArtifactIds(manifestA),
          options: { defaultCollisionPolicy: 'skip', includeGlobal: true },
        },
        ctx,
      ),
    )
    expect(plan.canProceed).toBe(true)
    const collisions = [...plan.projects.flatMap((p) => p.collisions), ...plan.globalCollisions]
    expect(collisions).toEqual([])
    expect(plan.preflight.some((c) => c.status === 'fail' && c.blocking)).toBe(false)
    expect(plan.remap.affected.some((a) => a.label === 'Claude sessions' && a.count > 0)).toBe(true)
    // The derived worktree mapping put demo-onboarding next to the new project.
    expect(
      plan.remap.mappings.some(
        (m) => m.newPath === path.join(destB.home.homeDir, 'Developer', 'demo-onboarding'),
      ),
    ).toBe(true)
  })

  it('execute (Scenario A): every provider succeeds, verification passes, re-auth is flagged', async () => {
    const plan = await runJob<RestorePlan>(servicesB, 'restore-plan', (ctx) =>
      servicesB.restore.plan(
        {
          backupPath: backupPathA,
          password: PASSWORD,
          mappings: mappingB,
          selectedArtifactIds: allArtifactIds(manifestA),
          options: { defaultCollisionPolicy: 'skip', includeGlobal: true },
        },
        ctx,
      ),
    )
    const result = await runJob<RestoreResult>(servicesB, 'restore', (ctx) =>
      servicesB.restore.execute({ planId: plan.id, collisionDecisions: {} }, ctx),
    )

    const outcomes = [...result.projects.flatMap((p) => p.providers), ...result.global]
    expect(outcomes.length).toBeGreaterThan(0)
    expect(outcomes.every((o) => o.status === 'ok')).toBe(true)
    expect(result.verification.ok).toBe(true)
    expect(
      result.attention.some(
        (a) =>
          a.providerId === 'claude-code' &&
          a.action === 'reauth' &&
          /authentication/i.test(a.title),
      ),
    ).toBe(true)
  })

  it('equivalence (Scenario A): the restore is logically identical under the new username/path', async () => {
    const destWorktree = path.join(destB.home.homeDir, 'Developer', 'demo-onboarding')
    const destEnv = { env: gitTestEnv(destB.home.homeDir) }

    // Git: primary + linked worktree state match (HEAD, branch, status, untracked, staged/unstaged, shape).
    expect(
      compareGitState(
        await captureGitState(source.projectPath, realExec, { env: source.repo.env }),
        await captureGitState(newDemoB, realExec, destEnv),
      ).differences,
    ).toEqual([])
    expect(
      compareGitState(
        await captureGitState(source.worktreePath, realExec, { env: source.repo.env }),
        await captureGitState(destWorktree, realExec, destEnv),
      ).differences,
    ).toEqual([])

    // Binary blob (unstaged modification) is byte-identical.
    expect(
      (await fs.readFile(path.join(newDemoB, 'assets', 'logo.png'))).equals(
        await fs.readFile(source.repo.files.logo!),
      ),
    ).toBe(true)

    // Claude sessions: the re-encoded project dir holds exactly the source project session ids…
    const projectsRoot = path.join(destB.home.claudeConfigDir, 'projects')
    const newProjectDir = path.join(projectsRoot, encodeClaudeProjectDir(newDemoB))
    expect(await listSessionIds(newProjectDir)).toEqual([...source.claude.projectSessionIds].sort())

    // …and every restored session id lives in EXACTLY ONE project dir (the resume rule).
    const dirs = await fs.readdir(projectsRoot)
    const locations = new Map<string, number>()
    for (const d of dirs) {
      for (const sid of await listSessionIds(path.join(projectsRoot, d))) {
        locations.set(sid, (locations.get(sid) ?? 0) + 1)
      }
    }
    for (const sid of source.claude.expectedProjectSessionIds) expect(locations.get(sid)).toBe(1)
    for (const sid of source.claude.otherSessionIds) expect(locations.has(sid)).toBe(false)

    // Every record's cwd is remapped; the assistant PROSE keeps the old path byte-for-byte (ADR-0005).
    const projectSession = source.claude.sessions.find((s) => s.kind === 'project')!
    const destTranscript = path.join(newProjectDir, `${projectSession.id}.jsonl`)
    const restored = (await readJsonl(destTranscript)).records
    for (const r of restored) if (typeof r.cwd === 'string') expect(r.cwd).toBe(newDemoB)
    const sourceRecords = (await readJsonl(projectSession.transcriptPath)).records
    const assistantUuid = projectSession.messageUuids[1]
    const srcAssistant = sourceRecords.find((r) => r.uuid === assistantUuid)!
    const dstAssistant = restored.find((r) => r.uuid === assistantUuid)!
    expect(JSON.stringify(dstAssistant.message)).toBe(JSON.stringify(srcAssistant.message))
    expect(JSON.stringify(dstAssistant.message)).toContain(source.projectPath)

    // Worktree session follows to the derived worktree dir; the orphaned Claude worktree stays under the project.
    const wtSession = source.claude.sessions.find((s) => s.kind === 'worktree')!
    const wtRecords = (
      await readJsonl(
        path.join(projectsRoot, encodeClaudeProjectDir(destWorktree), `${wtSession.id}.jsonl`),
      )
    ).records
    for (const r of wtRecords) if (typeof r.cwd === 'string') expect(r.cwd).toBe(destWorktree)
    const orphan = source.claude.sessions.find((s) => s.kind === 'orphan-worktree')!
    const orphanNewCwd = path.join(newDemoB, '.claude', 'worktrees', 'onboarding')
    const orphanRecords = (
      await readJsonl(
        path.join(projectsRoot, encodeClaudeProjectDir(orphanNewCwd), `${orphan.id}.jsonl`),
      )
    ).records
    for (const r of orphanRecords) if (typeof r.cwd === 'string') expect(r.cwd).toBe(orphanNewCwd)

    // Checkpoint blobs + memory present.
    const fhFiles = await fs.readdir(
      path.join(destB.home.claudeConfigDir, 'file-history', projectSession.id),
    )
    expect(fhFiles).toEqual(
      expect.arrayContaining([
        FIXTURE_FILE_HISTORY_BLOBS.indexTs,
        FIXTURE_FILE_HISTORY_BLOBS.readme,
      ]),
    )
    expect((await fs.readdir(path.join(newProjectDir, 'memory'))).sort()).toEqual([
      'MEMORY.md',
      'notes.md',
    ])

    // ~/.claude.json: project entry under the NEW path, and no identity/credentials leaked.
    const destJson = await readJson(destB.home.claudeJsonPath)
    expect(dig(destJson, 'projects', newDemoB)).toBeDefined()
    expect(destJson.oauthAccount).toBeUndefined()
    expect(destJson.userID).toBeUndefined()
    expect(destJson.machineID).toBeUndefined()

    // history.jsonl rows remapped to the new path (and none left under the old one).
    const history = (await readJsonl(path.join(destB.home.claudeConfigDir, 'history.jsonl')))
      .records
    expect(history.filter((r) => r.project === newDemoB).length).toBe(3)
    expect(history.every((r) => r.project !== source.projectPath)).toBe(true)

    // Project-side files restored; the sensitive .env.local was NOT (off by default).
    expect(await pathExists(path.join(newDemoB, 'CLAUDE.local.md'))).toBe(true)
    expect(
      (await fs.readFile(path.join(newDemoB, 'CLAUDE.local.md'))).equals(
        await fs.readFile(source.claude.projectFiles!.claudeLocalMd),
      ),
    ).toBe(true)
    expect(await pathExists(path.join(newDemoB, '.claude', 'settings.local.json'))).toBe(true)
    expect(await pathExists(path.join(newDemoB, '.env.local'))).toBe(false)
  })

  it('Scenario B: opt-in .env.local + MCP env round-trip into a fresh Mac B′', async () => {
    const backupPathB = path.join(tmp.root, 'B.devbackup')
    const resultB = await runJob<BackupResult>(servicesA, 'backup', (ctx) =>
      servicesA.backup.run(
        {
          scanId: scanA.id,
          selectedArtifactIds: [...defSel, envLocalId, mcpEnvId],
          outputPath: backupPathB,
          password: PASSWORD,
          label: 'Mac A opt-in',
        },
        ctx,
      ),
    )
    const manifestB = resultB.manifest

    const destB2 = await createDestinationMachineFixture(path.join(tmp.root, 'macB2'))
    const servicesB2 = makeServices(makeEnv(destB2.home), path.join(tmp.root, 'workB2'))
    disposables.push(servicesB2)
    const newDemoB2 = path.join(destB2.home.homeDir, 'Developer', 'demo')

    const plan = await runJob<RestorePlan>(servicesB2, 'restore-plan', (ctx) =>
      servicesB2.restore.plan(
        {
          backupPath: backupPathB,
          password: PASSWORD,
          mappings: [
            {
              projectId: manifestB.projects[0]!.id,
              oldPath: source.projectPath,
              newPath: newDemoB2,
            },
          ],
          selectedArtifactIds: allArtifactIds(manifestB),
          options: { defaultCollisionPolicy: 'skip', includeGlobal: true },
        },
        ctx,
      ),
    )
    expect(plan.canProceed).toBe(true)
    const result = await runJob<RestoreResult>(servicesB2, 'restore', (ctx) =>
      servicesB2.restore.execute({ planId: plan.id, collisionDecisions: {} }, ctx),
    )
    expect(
      [...result.projects.flatMap((p) => p.providers), ...result.global].every(
        (o) => o.status === 'ok',
      ),
    ).toBe(true)

    // .env.local restored byte-identical, with mode 0600.
    const destEnvFile = path.join(newDemoB2, '.env.local')
    expect(
      (await fs.readFile(destEnvFile)).equals(await fs.readFile(source.repo.files.envLocal!)),
    ).toBe(true)
    expect((await fs.stat(destEnvFile)).mode & 0o777).toBe(0o600)

    // The MCP env token is present in ~/.claude.json under the new path.
    const destJson = await readJson(destB2.home.claudeJsonPath)
    expect(dig(destJson, 'projects', newDemoB2, 'mcpServers', 'demo', 'env', 'DEMO_TOKEN')).toBe(
      FIXTURE_MCP_SECRET,
    )
  })

  it('Scenario C: re-restoring onto the same Mac B collides non-destructively', async () => {
    const beforeDemo = await hashTree(newDemoB)
    const beforeClaude = await hashTree(destB.home.claudeConfigDir)
    const beforeJson = await fs.readFile(destB.home.claudeJsonPath)

    const plan = await runJob<RestorePlan>(servicesB, 'restore-plan', (ctx) =>
      servicesB.restore.plan(
        {
          backupPath: backupPathA,
          password: PASSWORD,
          mappings: mappingB,
          selectedArtifactIds: allArtifactIds(manifestA),
          options: { defaultCollisionPolicy: 'skip', includeGlobal: true },
        },
        ctx,
      ),
    )
    const collisions = [...plan.projects.flatMap((p) => p.collisions), ...plan.globalCollisions]
    const kinds = new Set(collisions.map((c) => c.kind))
    expect(kinds.has('git-repo-exists')).toBe(true)
    expect(kinds.has('claude-project-exists')).toBe(true)
    // Every default is non-destructive (skip / add-only merge); the plan can still proceed.
    expect(collisions.every((c) => c.policy === 'skip' || c.policy === 'merge')).toBe(true)
    expect(plan.canProceed).toBe(true)

    const result = await runJob<RestoreResult>(servicesB, 'restore', (ctx) =>
      servicesB.restore.execute({ planId: plan.id, collisionDecisions: {} }, ctx),
    )
    const providerOutcomes = result.projects.flatMap((p) => p.providers)
    expect(providerOutcomes.find((o) => o.providerId === 'git')?.status).toBe('skipped')
    expect(providerOutcomes.find((o) => o.providerId === 'claude-code')?.status).toBe('ok')
    expect(result.global.find((o) => o.providerId === 'runtime')?.status).toBe('ok')

    // Nothing was destroyed: the destination is byte-for-byte what it was before the re-restore.
    expect(await hashTree(newDemoB)).toBe(beforeDemo)
    expect(await hashTree(destB.home.claudeConfigDir)).toBe(beforeClaude)
    expect((await fs.readFile(destB.home.claudeJsonPath)).equals(beforeJson)).toBe(true)
  })

  it('Scenario C: cancelling a restore leaves no destination directory behind', async () => {
    const destC = await createDestinationMachineFixture(path.join(tmp.root, 'macB3'))
    const servicesC = makeServices(makeEnv(destC.home), path.join(tmp.root, 'workC'))
    disposables.push(servicesC)
    const newDemoC = path.join(destC.home.homeDir, 'Developer', 'demo')

    const plan = await runJob<RestorePlan>(servicesC, 'restore-plan', (ctx) =>
      servicesC.restore.plan(
        {
          backupPath: backupPathA,
          password: PASSWORD,
          mappings: [
            {
              projectId: manifestA.projects[0]!.id,
              oldPath: source.projectPath,
              newPath: newDemoC,
            },
          ],
          selectedArtifactIds: allArtifactIds(manifestA),
          options: { defaultCollisionPolicy: 'skip', includeGlobal: true },
        },
        ctx,
      ),
    )

    // Start the execution job and cancel it immediately — before any provider writes a destination.
    const snap = servicesC.jobs.start('restore', (ctx) =>
      servicesC.restore.execute({ planId: plan.id, collisionDecisions: {} }, ctx),
    )
    servicesC.jobs.cancel(snap.id)
    const final = await servicesC.jobs.wait(snap.id)

    expect(final.status).toBe('cancelled')
    // No destination directory was created (git is the first provider and it never ran).
    expect(await pathExists(newDemoC)).toBe(false)
    // Nothing was written into ~/.claude either.
    expect(await pathExists(path.join(destC.home.claudeConfigDir, 'projects'))).toBe(false)
  })
})
