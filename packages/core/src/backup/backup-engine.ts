/**
 * DefaultBackupEngine: PLANNING → COLLECTING → PACKING → ENCRYPTING → VERIFYING.
 * Never mutates sources: providers write only through a ScopedFs bound to their staging subdirectory.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  DEVBACKUP_FORMAT,
  DEVBACKUP_FORMAT_VERSION,
  BackupRequest as BackupRequestSchema,
  Manifest as ManifestSchema,
  ManifestArtifact as ManifestArtifactSchema,
  type BackupRequest,
  type BackupResult,
  type Manifest,
  type ManifestArtifact,
  type ManifestProject,
  type ManifestProviderSection,
  type ProjectDescriptor,
  type ProviderScanResult,
  type ScannedArtifact,
} from '@devmig/model'
import {
  MigrationError,
  ScopedFs,
  canonicalizePath,
  expandHome,
  isSafeArchivePath,
  newId,
  pathExists,
  throwIfAborted,
} from '@devmig/shared'
import { z } from 'zod'
import type { BackupEngine, MigrationPlanner, ProjectScanner } from '../api'
import type { ArchiveAdapter } from '../archive-adapter'
import { collectCapabilitySnapshot } from '../capabilities/snapshot'
import { clamp01, errorMessage, makeBaseContext } from '../context'
import type { Environment } from '../environment'
import type { JobRunContext } from '../jobs/job-manager'
import { collectMachineInfo } from '../machine/collect-machine-info'
import type { BackupContext, MigrationProvider, ProviderBackupOutput } from '../providers/contract'
import type { ProviderRegistry } from '../providers/registry'

export interface DefaultBackupEngineOptions {
  env: Environment
  registry: ProviderRegistry
  scanner: ProjectScanner
  planner: MigrationPlanner
  archive: ArchiveAdapter
  appVersion: string
  /** Base directory for staging; created (0700) on demand. */
  workDir: string
}

const ProviderBackupOutputSchema = z.object({
  artifacts: z.array(ManifestArtifactSchema),
  schemaVersion: z.number().int().positive(),
  summary: z.record(z.string(), z.unknown()).optional(),
  restoreHints: z.record(z.string(), z.unknown()).optional(),
  warnings: z.array(z.string()).optional(),
})

export async function rmQuiet(p: string | undefined): Promise<void> {
  if (!p) return
  try {
    await fs.rm(p, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

/** Atomic JSON write (temp + fsync + rename) for engine-owned files inside staging. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const handle = await fs.open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, filePath)
}

function numberFromSummary(summary: Record<string, unknown> | undefined, key: string): number {
  const v = summary?.[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

function stringsFromSummary(summary: Record<string, unknown> | undefined, key: string): string[] {
  const value = summary?.[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function emptyScanResult(providerId: string, projectId?: string): ProviderScanResult {
  return {
    providerId,
    ...(projectId ? { projectId } : {}),
    detected: false,
    artifacts: [],
    summary: [],
    warnings: [],
    estimatedBytes: 0,
  }
}

export class DefaultBackupEngine implements BackupEngine {
  constructor(private readonly options: DefaultBackupEngineOptions) {}

  async run(rawRequest: BackupRequest, ctx: JobRunContext): Promise<BackupResult> {
    const startedAt = Date.now()
    const parsed = BackupRequestSchema.safeParse(rawRequest)
    if (!parsed.success) {
      throw new MigrationError('INVALID_INPUT', 'Invalid backup request.', {
        details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      })
    }
    const request = parsed.data
    const { env, registry, scanner, planner, archive } = this.options
    const warnings: string[] = []

    // ---- PLANNING ----
    ctx.setPhase('PLANNING', 'Planning backup…')
    const scan = scanner.getSession(request.scanId)
    if (!scan) {
      throw new MigrationError('PROJECT_NOT_FOUND', `Unknown scan session: ${request.scanId}`, {
        hint: 'Scan the projects again before creating a backup.',
        details: { scanId: request.scanId },
      })
    }
    const plan = planner.buildBackupPlan(scan, request.selectedArtifactIds)
    warnings.push(...plan.warnings)
    const outputPath = await this.validateOutputPath(request.outputPath)

    // ---- COLLECTING ----
    ctx.setPhase('COLLECTING', 'Collecting project state…')
    await fs.mkdir(this.options.workDir, { recursive: true, mode: 0o700 })
    const stagingRoot = await fs.mkdtemp(path.join(this.options.workDir, 'backup-'))
    await fs.chmod(stagingRoot, 0o700)
    const tempRoot = await fs.mkdtemp(path.join(this.options.workDir, 'backup-tmp-'))
    await fs.chmod(tempRoot, 0o700)
    let outputWritten = false
    let succeeded = false

    try {
      const providerVersions: Record<string, number> = {}
      const restoreHints: Record<string, unknown> = {}
      const manifestProjects: ManifestProject[] = []
      const globalSections: ManifestProviderSection[] = []
      let artifactCount = 0
      let payloadBytes = 0
      let claudeSessionCount = 0
      let worktreeCount = 0

      const totalUnits =
        plan.projects.reduce(
          (n, p) => n + [...p.providers.values()].filter((a) => a.length > 0).length,
          0,
        ) + [...plan.global.values()].filter((a) => a.length > 0).length
      let doneUnits = 0

      const collect = async (
        provider: MigrationProvider,
        project: ProjectDescriptor | undefined,
        artifacts: ScannedArtifact[],
        scanResult: ProviderScanResult,
      ): Promise<ManifestProviderSection> => {
        throwIfAborted(ctx.signal)
        const relDir = project
          ? path.posix.join('projects', project.id, provider.id)
          : path.posix.join('global', provider.id)
        const providerDir = path.join(stagingRoot, relDir)
        await fs.mkdir(providerDir, { recursive: true, mode: 0o700 })
        const tempDir = await fs.mkdtemp(path.join(tempRoot, `${provider.id}-`))
        const attribution = {
          ...(project ? { projectId: project.id } : {}),
          providerId: provider.id,
        }
        const itemId = `${project?.id ?? 'global'}:${provider.id}`
        const itemLabel = project
          ? `${provider.displayName} · ${project.name}`
          : `${provider.displayName} (user-wide)`
        ctx.progress(`Collecting ${itemLabel}…`, {
          ...attribution,
          ...(totalUnits > 0 ? { progress: doneUnits / totalUnits } : {}),
          item: { id: itemId, label: itemLabel, status: 'running' },
        })
        const backupCtx: BackupContext = {
          ...makeBaseContext(env, ctx, attribution),
          stagingDir: providerDir,
          fs: new ScopedFs([providerDir]),
          payloadPathFor: (rel) => {
            const clean = rel
              .split(path.sep)
              .join('/')
              .replace(/^\.\/+/, '')
            if (!isSafeArchivePath(clean)) {
              throw new MigrationError('INVALID_INPUT', `Unsafe payload path: ${rel}`, {
                details: { rel },
              })
            }
            return `${relDir}/${clean}`
          },
          tempDir,
        }
        let output: ProviderBackupOutput
        try {
          output = await provider.createBackupArtifacts(
            { ...(project ? { project } : {}), artifacts, scan: scanResult },
            backupCtx,
          )
        } catch (err) {
          if (ctx.signal.aborted) throw err
          ctx.progress(`${itemLabel} failed`, {
            ...attribution,
            level: 'error',
            item: { id: itemId, label: itemLabel, status: 'failed' },
          })
          if (err instanceof MigrationError) throw err
          throw new MigrationError(
            'PROVIDER_FAILED',
            `${provider.displayName} failed while collecting ${project ? project.name : 'user-wide state'}: ${errorMessage(err)}`,
            { details: { providerId: provider.id, projectId: project?.id }, cause: err },
          )
        }
        const section = await this.validateOutput(provider, project, output, relDir, stagingRoot)
        providerVersions[provider.id] = output.schemaVersion
        if (output.restoreHints) {
          for (const [k, v] of Object.entries(output.restoreHints)) {
            if (k in restoreHints) {
              ctx.logger.debug('restoreHints key overwritten', { key: k, providerId: provider.id })
            }
            restoreHints[k] = v
          }
        }
        for (const w of output.warnings ?? []) warnings.push(`${itemLabel}: ${w}`)
        artifactCount += section.artifacts.length
        payloadBytes += section.artifacts.reduce((n, a) => n + a.sizeBytes, 0)
        claudeSessionCount += numberFromSummary(section.summary, 'sessionCount')
        worktreeCount += numberFromSummary(section.summary, 'worktreeCount')
        doneUnits += 1
        ctx.progress(`✓ ${itemLabel}`, {
          ...attribution,
          ...(totalUnits > 0 ? { progress: doneUnits / totalUnits } : {}),
          item: {
            id: itemId,
            label: itemLabel,
            status: (output.warnings?.length ?? 0) > 0 ? 'warn' : 'done',
          },
        })
        return section
      }

      for (const entry of plan.projects) {
        const scanned = scan.projects.find((p) => p.project.id === entry.project.id)
        const sections: ManifestProviderSection[] = []
        for (const provider of registry.all()) {
          const artifacts = entry.providers.get(provider.id)
          if (!artifacts || artifacts.length === 0) continue
          const scanResult =
            scanned?.providers.find((r) => r.providerId === provider.id) ??
            emptyScanResult(provider.id, entry.project.id)
          sections.push(await collect(provider, entry.project, artifacts, scanResult))
        }
        const manifestProject: ManifestProject = {
          id: entry.project.id,
          name: entry.project.name,
          originalPath: entry.project.originalPath,
          canonicalPath: entry.project.canonicalPath,
          providers: sections,
        }
        if (entry.project.git) manifestProject.git = entry.project.git
        manifestProjects.push(manifestProject)
      }
      for (const provider of registry.all()) {
        const artifacts = plan.global.get(provider.id)
        if (!artifacts || artifacts.length === 0) continue
        const scanResult =
          scan.global.find((r) => r.providerId === provider.id) ?? emptyScanResult(provider.id)
        globalSections.push(await collect(provider, undefined, artifacts, scanResult))
      }

      throwIfAborted(ctx.signal)
      ctx.progress('Capturing machine information…')
      const machine = await collectMachineInfo(env.exec, {
        homeDir: env.homeDir,
        env: env.env,
        signal: ctx.signal,
      })
      const transcriptWriterVersions = [
        ...manifestProjects.flatMap((p) =>
          p.providers.flatMap((s) => stringsFromSummary(s.summary, 'claudeCodeVersions')),
        ),
        ...globalSections.flatMap((s) => stringsFromSummary(s.summary, 'claudeCodeVersions')),
      ]
      const capabilities = await collectCapabilitySnapshot(env, {
        role: 'source',
        machine,
        transcriptWriterVersions,
        signal: ctx.signal,
      })
      const manifest: Manifest = ManifestSchema.parse({
        format: DEVBACKUP_FORMAT,
        formatVersion: DEVBACKUP_FORMAT_VERSION,
        id: newId('backup'),
        label: request.label,
        createdAt: new Date().toISOString(),
        appVersion: this.options.appVersion,
        machine,
        providers: providerVersions,
        projects: manifestProjects,
        global: globalSections,
        stats: {
          projectCount: manifestProjects.length,
          artifactCount,
          payloadBytes,
          claudeSessionCount,
          worktreeCount,
        },
        restoreHints,
        capabilities,
      } satisfies Manifest)
      await writeJsonAtomic(path.join(stagingRoot, 'machine.json'), machine)
      await writeJsonAtomic(path.join(stagingRoot, 'manifest.json'), manifest)

      // ---- PACKING ---- (job-level checklist items 'pack' / 'encrypt' / 'verify' carry no projectId)
      ctx.setPhase('PACKING', 'Computing checksums…')
      throwIfAborted(ctx.signal)
      ctx.progress('Computing checksums…', {
        item: { id: 'pack', label: 'Package payload', status: 'running' },
      })
      const checksums = await archive.writeChecksumsFile(stagingRoot)
      ctx.progress(`✓ Packaged ${checksums.entries.length} file(s)`, {
        item: { id: 'pack', label: 'Package payload', status: 'done' },
      })

      // ---- ENCRYPTING ----
      ctx.setPhase('ENCRYPTING', 'Encrypting backup…')
      throwIfAborted(ctx.signal)
      ctx.progress('Encrypting backup…', {
        item: { id: 'encrypt', label: 'Encrypt backup', status: 'running' },
      })
      outputWritten = true
      const created = await archive.createDevBackup({
        sourceDir: stagingRoot,
        outputPath,
        password: request.password,
        manifest,
        signal: ctx.signal,
        onProgress: (p) => {
          ctx.progress(p.message ?? `Encrypting… ${p.entries} entries`, {
            ...(p.totalBytes ? { progress: clamp01(p.bytes / p.totalBytes) } : {}),
          })
        },
      })
      for (const w of created.warnings ?? []) warnings.push(`Packaging: ${w}`)
      ctx.progress(`✓ Encrypted ${created.entries} entries`, {
        progress: 1,
        item: { id: 'encrypt', label: 'Encrypt backup', status: 'done' },
      })

      // ---- VERIFYING ----
      ctx.setPhase('VERIFYING', 'Verifying backup…')
      throwIfAborted(ctx.signal)
      ctx.progress('Verifying backup…', {
        item: { id: 'verify', label: 'Verify backup', status: 'running' },
      })
      const verification = await archive.verifyDevBackup({
        path: outputPath,
        password: request.password,
        signal: ctx.signal,
        onProgress: (p) => {
          ctx.progress(p.message ?? `Verifying… ${p.entries} entries`, {
            ...(p.totalBytes ? { progress: clamp01(p.bytes / p.totalBytes) } : {}),
          })
        },
      })
      if (verification.manifest.id !== manifest.id) {
        throw new MigrationError(
          'INTEGRITY_MISMATCH',
          'The written backup does not contain the expected manifest.',
          { details: { expected: manifest.id, actual: verification.manifest.id } },
        )
      }
      const sizeBytes = created.sizeBytes || (await fs.stat(outputPath)).size
      succeeded = true
      ctx.progress(`✓ Backup written to ${outputPath}`, {
        progress: 1,
        item: { id: 'verify', label: 'Verify backup', status: 'done' },
      })
      return {
        outputPath,
        sizeBytes,
        manifest,
        verified: verification.ok,
        durationMs: Date.now() - startedAt,
        warnings,
      }
    } finally {
      await rmQuiet(stagingRoot)
      await rmQuiet(tempRoot)
      if (!succeeded && outputWritten) {
        ctx.logger.info('Removing partial backup output', { outputPath })
        await rmQuiet(outputPath)
      }
    }
  }

  private async validateOutputPath(requested: string): Promise<string> {
    const expanded = expandHome(requested.trim(), this.options.env.homeDir)
    if (!path.isAbsolute(expanded)) {
      throw new MigrationError('INVALID_INPUT', `Output path must be absolute: ${requested}`, {
        details: { outputPath: requested },
      })
    }
    const outputPath = canonicalizePath(expanded, this.options.env.homeDir)
    const parent = path.dirname(outputPath)
    let parentStat
    try {
      parentStat = await fs.stat(parent)
    } catch {
      throw new MigrationError('PATH_NOT_FOUND', `Destination folder does not exist: ${parent}`, {
        details: { parent },
        hint: 'Choose an existing folder for the backup file.',
      })
    }
    if (!parentStat.isDirectory()) {
      throw new MigrationError('NOT_A_DIRECTORY', `Destination is not a folder: ${parent}`, {
        details: { parent },
      })
    }
    try {
      await fs.access(parent, fs.constants.W_OK)
    } catch {
      throw new MigrationError(
        'PERMISSION_DENIED',
        `Destination folder is not writable: ${parent}`,
        {
          details: { parent },
        },
      )
    }
    if (await pathExists(outputPath)) {
      throw new MigrationError('INVALID_INPUT', `A file already exists at ${outputPath}`, {
        details: { outputPath },
        hint: 'Choose a different file name; existing backups are never overwritten.',
      })
    }
    return outputPath
  }

  private async validateOutput(
    provider: MigrationProvider,
    project: ProjectDescriptor | undefined,
    output: ProviderBackupOutput,
    relDir: string,
    stagingRoot: string,
  ): Promise<ManifestProviderSection> {
    const fail = (message: string): never => {
      throw new MigrationError(
        'PROVIDER_FAILED',
        `${provider.displayName} produced an invalid backup section: ${message}`,
        { details: { providerId: provider.id, projectId: project?.id } },
      )
    }
    const parsed = ProviderBackupOutputSchema.safeParse(output)
    if (!parsed.success) {
      return fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const artifacts: ManifestArtifact[] = []
    const seen = new Set<string>()
    for (const artifact of parsed.data.artifacts) {
      const id = artifact.id.startsWith(`${provider.id}:`)
        ? artifact.id
        : `${provider.id}:${artifact.id}`
      if (seen.has(id)) fail(`duplicate artifact id ${id}`)
      seen.add(id)
      const payloadPath = artifact.payloadPath.replace(/^\.\/+/, '')
      if (!isSafeArchivePath(payloadPath) || !payloadPath.startsWith(`${relDir}/`)) {
        fail(`payloadPath "${artifact.payloadPath}" is outside the provider staging dir ${relDir}/`)
      }
      try {
        await fs.lstat(path.join(stagingRoot, ...payloadPath.split('/')))
      } catch {
        fail(`payloadPath "${payloadPath}" does not exist in the staging directory`)
      }
      artifacts.push({ ...artifact, id, providerId: provider.id, payloadPath })
    }
    return {
      providerId: provider.id,
      schemaVersion: parsed.data.schemaVersion,
      artifacts,
      summary: parsed.data.summary ?? {},
    }
  }
}
