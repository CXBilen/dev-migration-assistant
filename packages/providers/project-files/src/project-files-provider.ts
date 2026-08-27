/**
 * @devmig/provider-project-files — local files Git does not carry (.env*, .nvmrc, .npmrc, compose
 * overrides, local certificates) for a project and its linked worktrees.
 *
 * Scan: discover candidates per worktree root, ask `git check-ignore` which ones Git ignores (only those
 * are ours; the rest are captured by the Git provider), classify each file with the core secret classifier.
 * Backup: copy selected files under files/<worktreeIndex>/<relpath> + index.json.
 * Restore: mapPath(worktree root) + relpath, `file-exists` collisions (skip | backup-then-replace),
 * atomic writes with the original mode (0600 for anything sensitive). Verify: sha256 per restored file.
 */
import { promises as fs, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  classifyFile,
  type BackupContext,
  type DetectionContext,
  type MigrationProvider,
  type ProviderBackupInput,
  type ProviderBackupOutput,
  type ProviderDetection,
  type ProviderRestoreInput,
  type ProviderRestorePlan,
  type ProviderRestoreResult,
  type ProviderVerification,
  type ProviderVerifyInput,
  type RestoreContext,
  type RestorePlanningContext,
  type ScanContext,
  type VerifyContext,
} from '@devmig/core'
import type {
  AttentionItem,
  Collision,
  CollisionPolicy,
  ManifestArtifact,
  PreflightCheck,
  ProjectDescriptor,
  ProviderScanResult,
  ResultItem,
  RestoreStep,
  ScannedArtifact,
  Sensitivity,
  SummaryItem,
  VerificationCheck,
} from '@devmig/model'
import {
  MigrationError,
  displayPath,
  hashFile,
  isAbortError,
  isMigrationError,
  safeJoin,
  stableId,
  throwIfAborted,
  toPosix,
} from '@devmig/shared'
import {
  MAX_PROJECT_FILE_BYTES,
  categoryLabel,
  discoverCandidates,
  type CandidateFile,
} from './candidates'
import { checkIgnored } from './git-ignore'
import {
  ManifestFileMeta,
  PlanState,
  type ProjectFilesIndex,
  RestoreState,
  ScannedFileMeta,
  type IndexEntry,
  type PlannedFile,
  type SkippedFile,
  type WrittenFile,
} from './schema'

export const PROJECT_FILES_PROVIDER_ID = 'project-files'
export const PROJECT_FILES_SCHEMA_VERSION = 1
export const PROJECT_FILES_PROVIDER_VERSION = '0.1.0'

/** Bytes sniffed per payload file when looking for old-path references at plan time. */
const PATH_REFERENCE_SNIFF_BYTES = 256 * 1024
const MAX_SUMMARY_ROWS = 12

interface WorktreeRoot {
  index: number
  path: string
  label: string
}

/** Roots to scan: the project itself (index 0) and every other worktree Git knows about. */
export function resolveWorktreeRoots(
  project: ProjectDescriptor,
  allProjects: readonly ProjectDescriptor[],
): WorktreeRoot[] {
  const roots: WorktreeRoot[] = [{ index: 0, path: project.realPath, label: project.name }]
  const seen = new Set<string>([project.realPath])
  const otherProjects = new Set(
    allProjects.filter((p) => p.id !== project.id).map((p) => p.realPath),
  )
  for (const wt of project.git?.worktrees ?? []) {
    if (seen.has(wt.path)) continue
    seen.add(wt.path)
    // A worktree that is itself a selected project scans its own files.
    if (otherProjects.has(wt.path)) continue
    roots.push({ index: roots.length, path: wt.path, label: path.basename(wt.path) })
  }
  return roots
}

function artifactIdFor(projectId: string, worktreeIndex: number, relpath: string): string {
  const id = `${PROJECT_FILES_PROVIDER_ID}:${projectId}:${worktreeIndex}:${relpath}`
  if (id.length <= 256) return id
  return `${PROJECT_FILES_PROVIDER_ID}:${projectId}:${worktreeIndex}:${stableId(relpath)}`
}

function formatTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

/** `<path>.devmig-backup-<timestamp>` — a sibling of the file, so it stays inside the approved root. */
function asidePathFor(destination: string, stamp: string): string {
  return `${destination}.devmig-backup-${stamp}`
}

/** The planned aside path, or the first free `-2`, `-3`… variant next to it when something took it meanwhile. */
async function availableAsidePath(candidate: string): Promise<string> {
  if ((await lstatOrNull(candidate)) === null) return candidate
  for (let n = 2; n < 1000; n += 1) {
    const alternative = `${candidate}-${n}`
    if ((await lstatOrNull(alternative)) === null) return alternative
  }
  throw new MigrationError(
    'RESTORE_DESTINATION_EXISTS',
    `Could not find a free backup name next to ${candidate}.`,
    { details: { candidate } },
  )
}

function restoreMode(sensitivity: Sensitivity, original: number): number {
  if (sensitivity !== 'safe') return 0o600
  const mode = original & 0o777
  return mode === 0 ? 0o644 : mode | 0o600
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p)
  } catch {
    return null
  }
}

/** Bounded, text-only check whether a payload file mentions the old project path (never rewritten). */
async function mentionsPath(file: string, needle: string, signal: AbortSignal): Promise<boolean> {
  if (!needle) return false
  let handle: FileHandle | undefined
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return false
    handle = await fs.open(file, 'r')
    const buf = Buffer.alloc(Math.min(stat.size, PATH_REFERENCE_SNIFF_BYTES))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    throwIfAborted(signal)
    const data = buf.subarray(0, bytesRead)
    if (data.includes(0)) return false
    return data.toString('utf8').includes(needle)
  } catch (err) {
    if (isMigrationError(err) && err.code === 'CANCELLED') throw err
    return false
  } finally {
    await handle?.close()
  }
}

export class ProjectFilesProvider implements MigrationProvider {
  readonly id = PROJECT_FILES_PROVIDER_ID
  readonly displayName = 'Project files'
  readonly version = PROJECT_FILES_PROVIDER_VERSION
  readonly schemaVersion = PROJECT_FILES_SCHEMA_VERSION
  readonly supportsGlobal = false

  async detect(ctx: DetectionContext): Promise<ProviderDetection> {
    let gitAvailable: boolean
    try {
      const result = await ctx.exec('git', ['--version'], {
        reject: false,
        timeoutMs: 5_000,
        env: ctx.env,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      gitAvailable = !result.failed
    } catch (err) {
      if (isMigrationError(err) && err.code === 'CANCELLED') throw err
      gitAvailable = false
    }
    return {
      providerId: this.id,
      available: true,
      version: this.version,
      details: { git: gitAvailable ? 'available' : 'missing' },
      notes: gitAvailable
        ? []
        : [
            'Git is not available; every local file will be listed because ignore rules cannot be evaluated.',
          ],
    }
  }

  async scanProject(project: ProjectDescriptor, ctx: ScanContext): Promise<ProviderScanResult> {
    const artifacts: ScannedArtifact[] = []
    const summary: SummaryItem[] = []
    const warnings: string[] = []
    const roots = resolveWorktreeRoots(project, ctx.allProjects)
    const isRepo = project.git !== undefined
    let capturedByGit = 0
    let estimatedBytes = 0

    for (const root of roots) {
      throwIfAborted(ctx.signal)
      const rootStat = await lstatOrNull(root.path)
      if (!rootStat?.isDirectory()) {
        if (root.index > 0) {
          warnings.push(`Worktree ${root.path} does not exist on disk; skipped.`)
        }
        continue
      }
      ctx.progress(`Looking for local files in ${displayPath(root.path, ctx.homeDir)}…`)
      const candidates = await discoverCandidates(root.path, {
        signal: ctx.signal,
        onSkip: (relpath, reason) => {
          ctx.logger.debug('Candidate skipped', { root: root.path, relpath, reason })
          if (reason.startsWith('symbolic')) {
            warnings.push(`${relpath} in ${root.label} is a symbolic link and was skipped.`)
          }
        },
      })
      if (candidates.length === 0) continue

      let ignored: Set<string> | null = null
      if (isRepo) {
        const check = await checkIgnored(
          ctx.exec,
          root.path,
          candidates.map((c) => c.relpath),
          ctx.signal,
        )
        if (check.status === 'ok') {
          ignored = check.ignored
        } else {
          warnings.push(
            `Could not ask Git which files in ${root.label} are ignored (${check.error ?? 'unknown error'}); every local file is listed.`,
          )
          ctx.logger.warn('git check-ignore unavailable', { root: root.path, error: check.error })
        }
      }

      for (const candidate of candidates) {
        throwIfAborted(ctx.signal)
        const gitStatus: ScannedFileMeta['gitStatus'] = !isRepo
          ? 'not-a-repo'
          : ignored === null
            ? 'unknown'
            : ignored.has(candidate.relpath)
              ? 'ignored'
              : 'captured-by-git'
        const artifact = await this.describeCandidate(project, root, candidate, gitStatus, ctx)
        artifacts.push(artifact)
        if (gitStatus === 'captured-by-git') {
          capturedByGit += 1
          continue
        }
        if (artifact.includedByDefault) estimatedBytes += candidate.sizeBytes
        if (summary.length < MAX_SUMMARY_ROWS) summary.push(summaryRowFor(artifact, root))
      }
    }

    const selectable = artifacts.filter((a) => a.selectable)
    if (selectable.length > MAX_SUMMARY_ROWS) {
      summary.push({
        label: `${selectable.length - MAX_SUMMARY_ROWS} more local files`,
        status: 'info',
      })
    }
    if (capturedByGit > 0) {
      summary.push({
        label: `${capturedByGit} ${capturedByGit === 1 ? 'file is' : 'files are'} captured by Git working tree state`,
        status: 'info',
        detail: 'tracked or untracked files travel with the Git provider',
      })
    }
    if (!isRepo && artifacts.length > 0) {
      summary.push({ label: 'Not a Git repository — all local files listed', status: 'info' })
    }
    if (artifacts.length === 0) {
      summary.push({ label: 'No local project files found', status: 'info' })
    }

    return {
      providerId: this.id,
      projectId: project.id,
      detected: artifacts.length > 0,
      artifacts,
      summary,
      warnings,
      estimatedBytes,
    }
  }

  private async describeCandidate(
    project: ProjectDescriptor,
    root: WorktreeRoot,
    candidate: CandidateFile,
    gitStatus: ScannedFileMeta['gitStatus'],
    ctx: ScanContext,
  ): Promise<ScannedArtifact> {
    const classification = await classifyFile(candidate.absPath, { signal: ctx.signal })
    const reasons: string[] = []
    let sensitivity: Sensitivity = classification.sensitivity
    if (classification.sensitivity === 'credential') {
      // Core never migrates credential-class artifacts; a local dev key is still restorable on
      // explicit opt-in, so it travels as 'sensitive' with the credential classification spelled out.
      sensitivity = 'sensitive'
      reasons.push(
        'Private key material — off by default; include only if you really need it on the new Mac',
      )
    }
    reasons.push(...classification.reasons)
    const tooLarge = candidate.sizeBytes > MAX_PROJECT_FILE_BYTES
    const gitCaptured = gitStatus === 'captured-by-git'
    if (gitCaptured) reasons.push('Captured by Git working tree state')
    if (tooLarge)
      reasons.push(`Larger than ${MAX_PROJECT_FILE_BYTES / (1024 * 1024)} MiB; not a project file`)
    const selectable = !gitCaptured && !tooLarge
    const includedByDefault = selectable && sensitivity === 'safe'
    const meta: ScannedFileMeta = {
      relpath: candidate.relpath,
      worktreeIndex: root.index,
      worktreeRoot: root.path,
      absPath: candidate.absPath,
      mode: candidate.mode,
      sizeBytes: candidate.sizeBytes,
      category: candidate.category,
      classification: classification.sensitivity,
      gitStatus,
    }
    const where = root.index === 0 ? '' : ` · ${root.label}`
    const descriptionParts = [categoryLabel(candidate.category)]
    if (classification.sensitivity === 'credential') descriptionParts.push('private key')
    else if (sensitivity === 'sensitive') descriptionParts.push('may contain secrets')
    if (gitCaptured) descriptionParts.push('restored by Git')
    return {
      id: artifactIdFor(project.id, root.index, candidate.relpath),
      providerId: this.id,
      projectId: project.id,
      scope: 'project',
      kind: 'file',
      label: `${candidate.relpath}${where}`,
      description: descriptionParts.join(' · '),
      sourcePath: displayPath(candidate.absPath, ctx.homeDir),
      sizeBytes: candidate.sizeBytes,
      count: 1,
      sensitivity,
      includedByDefault,
      selectable,
      reasons: [...new Set(reasons)],
      meta,
    }
  }

  async createBackupArtifacts(
    input: ProviderBackupInput,
    ctx: BackupContext,
  ): Promise<ProviderBackupOutput> {
    const artifacts: ManifestArtifact[] = []
    const entries: IndexEntry[] = []
    const warnings: string[] = []
    const indexPath = ctx.payloadPathFor('index.json')
    let sensitiveCount = 0
    const worktrees = new Set<number>()
    const total = input.artifacts.length

    for (const [i, artifact] of input.artifacts.entries()) {
      throwIfAborted(ctx.signal)
      if (!artifact.selectable) {
        throw new MigrationError(
          'INVALID_INPUT',
          `${artifact.label} is shown for transparency only and cannot be backed up.`,
          { details: { artifactId: artifact.id } },
        )
      }
      const parsed = ScannedFileMeta.safeParse(artifact.meta)
      if (!parsed.success) {
        throw new MigrationError(
          'PROVIDER_FAILED',
          `Artifact ${artifact.id} carries invalid metadata.`,
          {
            details: { artifactId: artifact.id, issues: parsed.error.issues.map((x) => x.message) },
          },
        )
      }
      const meta = parsed.data
      ctx.progress(`Copying ${meta.relpath}`, total > 0 ? i / total : undefined, {
        id: artifact.id,
        label: artifact.label,
        status: 'running',
      })
      const stat = await lstatOrNull(meta.absPath)
      if (!stat) {
        warnings.push(`${meta.relpath} disappeared before it could be copied; skipped.`)
        ctx.progress(`${meta.relpath} missing`, undefined, {
          id: artifact.id,
          label: artifact.label,
          status: 'skipped',
        })
        continue
      }
      if (!stat.isFile()) {
        throw new MigrationError('INVALID_INPUT', `${meta.relpath} is not a regular file.`, {
          details: { path: meta.absPath },
        })
      }
      if (stat.size > MAX_PROJECT_FILE_BYTES) {
        throw new MigrationError(
          'INVALID_INPUT',
          `${meta.relpath} is too large to be a project file.`,
          {
            details: { path: meta.absPath, sizeBytes: stat.size },
          },
        )
      }
      const rel = path.posix.join('files', String(meta.worktreeIndex), meta.relpath)
      const staged = safeJoin(ctx.stagingDir, rel)
      await ctx.fs.copyFile(meta.absPath, staged)
      const { sha256, sizeBytes } = await hashFile(staged, ctx.signal)
      const payloadPath = ctx.payloadPathFor(rel)
      const manifestMeta: ManifestFileMeta = {
        relpath: meta.relpath,
        worktreeIndex: meta.worktreeIndex,
        worktreeRoot: meta.worktreeRoot,
        mode: meta.mode,
        sha256,
        category: meta.category,
        classification: meta.classification,
        indexPath,
      }
      artifacts.push({
        id: artifact.id,
        providerId: this.id,
        kind: 'file',
        label: artifact.label,
        payloadPath,
        sizeBytes,
        fileCount: 1,
        sensitivity: artifact.sensitivity,
        sourcePath: meta.absPath,
        meta: manifestMeta,
      })
      entries.push({
        relpath: meta.relpath,
        worktreeIndex: meta.worktreeIndex,
        worktreeRoot: meta.worktreeRoot,
        payloadPath,
        sizeBytes,
        sha256,
        sensitivity: artifact.sensitivity,
        mode: meta.mode,
        category: meta.category,
      })
      if (artifact.sensitivity !== 'safe') sensitiveCount += 1
      worktrees.add(meta.worktreeIndex)
      ctx.progress(`Copied ${meta.relpath}`, total > 0 ? (i + 1) / total : undefined, {
        id: artifact.id,
        label: artifact.label,
        status: 'done',
      })
    }

    const index: ProjectFilesIndex = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      files: entries,
    }
    await ctx.fs.writeFileAtomic(
      path.join(ctx.stagingDir, 'index.json'),
      `${JSON.stringify(index, null, 2)}\n`,
      0o600,
    )
    return {
      artifacts,
      schemaVersion: this.schemaVersion,
      summary: {
        fileCount: entries.length,
        sensitiveCount,
        worktreeCount: worktrees.size,
        bytes: entries.reduce((n, e) => n + e.sizeBytes, 0),
      },
      warnings,
    }
  }

  async planRestore(
    input: ProviderRestoreInput,
    ctx: RestorePlanningContext,
  ): Promise<ProviderRestorePlan> {
    const steps: RestoreStep[] = []
    const collisions: Collision[] = []
    const preflight: PreflightCheck[] = []
    const warnings: string[] = []
    const unsupportedReferences: { location: string; reason: string }[] = []
    const files: PlannedFile[] = []
    const asidePaths: string[] = []
    const roots = new Map<string, { index: number; oldRoot: string; newRoot: string }>()
    const planStamp = formatTimestamp(new Date())
    let relocated = 0

    for (const artifact of input.artifacts) {
      throwIfAborted(ctx.signal)
      const parsed = ManifestFileMeta.safeParse(artifact.meta)
      if (!parsed.success) {
        throw new MigrationError(
          'MANIFEST_INVALID',
          `Artifact ${artifact.id} carries invalid metadata.`,
          {
            details: { artifactId: artifact.id, issues: parsed.error.issues.map((x) => x.message) },
          },
        )
      }
      const meta = parsed.data
      const mapped = ctx.mapPath(meta.worktreeRoot)
      const destinationRoot = mapped.newPath
      let destination: string
      try {
        destination = safeJoin(destinationRoot, meta.relpath)
      } catch (err) {
        throw new MigrationError(
          'ARCHIVE_ENTRY_REJECTED',
          `Refusing to restore ${meta.relpath}: it would escape ${destinationRoot}.`,
          { details: { relpath: meta.relpath }, cause: err },
        )
      }
      if (!roots.has(destinationRoot)) {
        roots.set(destinationRoot, {
          index: meta.worktreeIndex,
          oldRoot: meta.worktreeRoot,
          newRoot: destinationRoot,
        })
      }
      if (mapped.changed) relocated += 1
      const payloadFile = safeJoin(ctx.payloadRoot, artifact.payloadPath)
      const payloadStat = await lstatOrNull(payloadFile)
      if (!payloadStat?.isFile()) {
        throw new MigrationError('ARCHIVE_INVALID', `Payload file missing for ${meta.relpath}.`, {
          details: { payloadPath: artifact.payloadPath },
        })
      }
      if (mapped.changed && (await mentionsPath(payloadFile, meta.worktreeRoot, ctx.signal))) {
        unsupportedReferences.push({
          location:
            meta.worktreeIndex === 0
              ? meta.relpath
              : `${meta.relpath} (worktree ${meta.worktreeIndex})`,
          reason: `Mentions the old path ${meta.worktreeRoot}; free-form file contents are never rewritten — review it after the restore.`,
        })
      }

      let collisionId: string | undefined
      let asidePath: string | undefined
      const existing = await lstatOrNull(destination)
      if (existing) {
        collisionId = `collision:${meta.worktreeIndex}/${meta.relpath}`
        asidePath = asidePathFor(destination, planStamp)
        asidePaths.push(asidePath)
        collisions.push({
          id: collisionId,
          providerId: this.id,
          ...(input.project ? { projectId: input.project.id } : {}),
          kind: 'file-exists',
          path: destination,
          detail: existing.isFile()
            ? `${meta.relpath} already exists at the destination (${existing.size} bytes).`
            : `${meta.relpath} exists at the destination but is not a regular file.`,
          allowedPolicies: ['skip', 'backup-then-replace'],
          policy: 'skip',
        })
      }
      const stepId = `restore:${meta.worktreeIndex}/${meta.relpath}`
      steps.push({
        id: stepId,
        providerId: this.id,
        ...(input.project ? { projectId: input.project.id } : {}),
        label: `Restore ${meta.relpath}`,
        detail:
          meta.worktreeIndex === 0
            ? `${categoryLabel(meta.category)}${artifact.sensitivity !== 'safe' ? ' · written with mode 0600' : ''}`
            : `${categoryLabel(meta.category)} in worktree ${path.basename(destinationRoot)}`,
        destination,
        artifactIds: [artifact.id],
      })
      files.push({
        artifactId: artifact.id,
        payloadPath: artifact.payloadPath,
        relpath: meta.relpath,
        worktreeIndex: meta.worktreeIndex,
        destinationRoot,
        destination,
        pathChanged: mapped.changed,
        ...(collisionId ? { collisionId } : {}),
        ...(asidePath ? { asidePath } : {}),
        sha256: meta.sha256,
        sizeBytes: artifact.sizeBytes,
        mode: meta.mode,
        sensitivity: artifact.sensitivity,
      })
    }

    for (const root of roots.values()) {
      const stat = await lstatOrNull(root.newRoot)
      const label =
        root.index === 0 ? `Project folder ${root.newRoot}` : `Worktree folder ${root.newRoot}`
      if (!stat) {
        preflight.push({
          id: `destination:${root.index}`,
          label,
          status: 'warn',
          detail: 'Does not exist yet; the Git restore creates it (or it is created on demand).',
          blocking: false,
        })
      } else if (!stat.isDirectory()) {
        preflight.push({
          id: `destination:${root.index}`,
          label,
          status: 'fail',
          detail: 'Exists but is not a folder.',
          blocking: true,
        })
      } else {
        let writable = true
        try {
          await fs.access(root.newRoot, fs.constants.W_OK)
        } catch {
          writable = false
        }
        preflight.push({
          id: `destination:${root.index}`,
          label,
          status: writable ? 'pass' : 'fail',
          ...(writable ? {} : { detail: 'Folder is not writable.' }),
          blocking: !writable,
        })
      }
    }

    return {
      providerId: this.id,
      ...(input.project ? { projectId: input.project.id } : {}),
      steps,
      collisions,
      preflight,
      remap: {
        affected:
          relocated > 0 ? [{ label: 'Local project files relocated', count: relocated }] : [],
        safeRewriteCount: 0,
        warnings: [],
        unsupportedReferences,
      },
      warnings,
      state: { files, asidePaths } satisfies PlanState,
    }
  }

  async restore(
    plan: ProviderRestorePlan,
    input: ProviderRestoreInput,
    ctx: RestoreContext,
  ): Promise<ProviderRestoreResult> {
    const state = PlanState.parse(plan.state)
    const items: ResultItem[] = []
    const warnings: string[] = []
    const written: WrittenFile[] = []
    const skipped: SkippedFile[] = []
    const failed: SkippedFile[] = []
    const policyById = new Map(plan.collisions.map((c) => [c.id, c.policy]))
    const total = state.files.length

    // Fail closed before touching anything: every destination must sit inside an approved root.
    for (const file of state.files) {
      if (!ctx.fs.isAllowed(file.destination)) {
        throw new MigrationError(
          'PATH_OUTSIDE_ALLOWED_ROOT',
          `Refusing to restore ${file.relpath}: ${file.destination} is outside the approved destinations.`,
          {
            details: { relpath: file.relpath, destination: file.destination, roots: ctx.fs.roots },
          },
        )
      }
    }

    const fail = (file: PlannedFile, reason: string): void => {
      failed.push({
        artifactId: file.artifactId,
        relpath: file.relpath,
        destination: file.destination,
        reason,
      })
      items.push({ label: file.relpath, status: 'error', detail: reason })
      warnings.push(`${file.relpath}: ${reason}`)
      ctx.progress(`${file.relpath} failed`, undefined, {
        id: file.artifactId,
        label: file.relpath,
        status: 'failed',
      })
    }

    for (const [i, file] of state.files.entries()) {
      throwIfAborted(ctx.signal)
      ctx.progress(`Restoring ${file.relpath}`, total > 0 ? i / total : undefined, {
        id: file.artifactId,
        label: file.relpath,
        status: 'running',
      })
      let movedAside: string | undefined
      try {
        const source = safeJoin(ctx.payloadRoot, file.payloadPath)
        const integrity = await hashFile(source, ctx.signal)
        if (integrity.sha256 !== file.sha256) {
          fail(file, 'Payload checksum mismatch; the file was not restored.')
          continue
        }

        // The Git restore normally creates the project/worktree folder first; create it on demand otherwise.
        const rootStat = await lstatOrNull(file.destinationRoot)
        if (!rootStat) {
          await ctx.fs.mkdir(file.destinationRoot, 0o755)
        } else if (!rootStat.isDirectory()) {
          fail(file, `Destination ${file.destinationRoot} exists but is not a folder.`)
          continue
        }

        if (await ctx.fs.exists(file.destination)) {
          const policy: CollisionPolicy =
            (file.collisionId ? ctx.collisionDecisions[file.collisionId] : undefined) ??
            (file.collisionId ? policyById.get(file.collisionId) : undefined) ??
            'skip'
          if (policy === 'skip') {
            const reason = 'A file already exists at the destination; kept as is.'
            skipped.push({
              artifactId: file.artifactId,
              relpath: file.relpath,
              destination: file.destination,
              reason,
            })
            items.push({ label: file.relpath, status: 'info', detail: `Skipped — ${reason}` })
            ctx.progress(`Skipped ${file.relpath}`, undefined, {
              id: file.artifactId,
              label: file.relpath,
              status: 'skipped',
            })
            continue
          }
          if (policy !== 'backup-then-replace') {
            throw new MigrationError(
              'INVALID_INPUT',
              `Collision policy "${policy}" is not supported for ${file.relpath}.`,
              { details: { relpath: file.relpath, policy } },
            )
          }
          const aside = await availableAsidePath(
            file.asidePath ?? asidePathFor(file.destination, formatTimestamp(new Date())),
          )
          await ctx.fs.rename(file.destination, aside)
          movedAside = aside
        }

        const mode = restoreMode(file.sensitivity, file.mode)
        // Streamed temp file in the destination folder + flush + rename; never loads the file into memory.
        await ctx.fs.copyFileAtomic(source, file.destination, mode)
        written.push({
          artifactId: file.artifactId,
          relpath: file.relpath,
          destination: file.destination,
          sha256: file.sha256,
          mode,
          sensitivity: file.sensitivity,
          ...(movedAside ? { backupPath: movedAside } : {}),
        })
        items.push({
          label: file.relpath,
          status: 'ok',
          detail: movedAside
            ? `Restored; previous file kept at ${path.basename(movedAside)}`
            : `Restored to ${file.destination}`,
        })
        ctx.progress(`Restored ${file.relpath}`, total > 0 ? (i + 1) / total : undefined, {
          id: file.artifactId,
          label: file.relpath,
          status: 'done',
        })
      } catch (err) {
        if (isAbortError(err) || (isMigrationError(err) && err.code === 'CANCELLED')) throw err
        const message = err instanceof Error ? err.message : String(err)
        let restoredOriginal = false
        if (movedAside !== undefined && !(await ctx.fs.exists(file.destination))) {
          // A replace that failed after the original was moved aside must never lose the user's file.
          restoredOriginal = await ctx.fs
            .rename(movedAside, file.destination)
            .then(() => true)
            .catch(() => false)
        }
        ctx.logger.warn('Project file restore failed', {
          relpath: file.relpath,
          destination: file.destination,
          error: message,
          restoredOriginal,
        })
        fail(
          file,
          restoredOriginal
            ? `${message} — the previous file was put back.`
            : movedAside !== undefined
              ? `${message} — the previous file is at ${movedAside}.`
              : message,
        )
      }
    }

    const attention: AttentionItem[] = []
    const sensitiveWritten = written.filter((w) => w.sensitivity !== 'safe')
    if (sensitiveWritten.length > 0) {
      attention.push({
        id: `${this.id}:review-secrets${input.project ? `:${input.project.id}` : ''}`,
        providerId: this.id,
        level: 'info',
        title: `Review ${sensitiveWritten.length} restored ${sensitiveWritten.length === 1 ? 'file' : 'files'} that may contain secrets`,
        detail: sensitiveWritten.map((w) => w.relpath).join(', '),
        action: 'manual',
      })
    }
    const status: ProviderRestoreResult['status'] =
      failed.length === 0 ? 'ok' : written.length > 0 || skipped.length > 0 ? 'partial' : 'failed'
    return {
      providerId: this.id,
      ...(input.project ? { projectId: input.project.id } : {}),
      status,
      items,
      warnings,
      attention,
      state: { written, skipped, failed } satisfies RestoreState,
    }
  }

  async verify(input: ProviderVerifyInput, ctx: VerifyContext): Promise<ProviderVerification> {
    const checks: VerificationCheck[] = []
    const state = RestoreState.parse(input.result.state ?? {})
    for (const file of state.written) {
      throwIfAborted(ctx.signal)
      const id = `verify:${toPosix(file.relpath)}`
      try {
        const actual = await hashFile(file.destination, ctx.signal)
        if (actual.sha256 !== file.sha256) {
          checks.push({
            id,
            label: file.relpath,
            status: 'fail',
            detail: `Checksum mismatch at ${file.destination}`,
          })
          continue
        }
        const stat = await fs.stat(file.destination)
        const mode = stat.mode & 0o777
        if (file.sensitivity !== 'safe' && mode !== 0o600) {
          checks.push({
            id,
            label: file.relpath,
            status: 'warn',
            detail: `Restored with checksum OK but permissions are ${mode.toString(8)} instead of 600`,
          })
          continue
        }
        checks.push({ id, label: file.relpath, status: 'pass', detail: `sha256 matches` })
      } catch (err) {
        if (isMigrationError(err) && err.code === 'CANCELLED') throw err
        checks.push({
          id,
          label: file.relpath,
          status: 'fail',
          detail: `Missing or unreadable: ${file.destination}`,
        })
      }
      if (file.backupPath) {
        const exists = (await lstatOrNull(file.backupPath)) !== null
        checks.push({
          id: `backup:${toPosix(file.relpath)}`,
          label: `${file.relpath} (previous file)`,
          status: exists ? 'pass' : 'warn',
          detail: exists
            ? `Kept at ${file.backupPath}`
            : `Expected backup ${file.backupPath} is missing`,
        })
      }
    }
    for (const file of state.skipped) {
      checks.push({
        id: `skipped:${toPosix(file.relpath)}`,
        label: file.relpath,
        status: 'warn',
        detail: `Skipped — ${file.reason}`,
      })
    }
    for (const file of state.failed) {
      checks.push({
        id: `failed:${toPosix(file.relpath)}`,
        label: file.relpath,
        status: 'fail',
        detail: file.reason,
      })
    }
    return { checks }
  }
}

function summaryRowFor(artifact: ScannedArtifact, root: WorktreeRoot): SummaryItem {
  const meta = artifact.meta as ScannedFileMeta
  const suffix = root.index === 0 ? '' : ` (${root.label})`
  if (!artifact.selectable) {
    return {
      label: `${meta.relpath}${suffix}`,
      status: 'info',
      detail: artifact.reasons[artifact.reasons.length - 1],
    }
  }
  if (artifact.sensitivity !== 'safe') {
    return {
      label: `${meta.relpath}${suffix} detected`,
      status: 'warn',
      detail:
        meta.classification === 'credential'
          ? 'private key — excluded unless you opt in'
          : 'sensitive — excluded unless you opt in',
    }
  }
  return { label: `${meta.relpath}${suffix}`, status: 'ok' }
}

export function createProjectFilesProvider(): MigrationProvider {
  return new ProjectFilesProvider()
}
