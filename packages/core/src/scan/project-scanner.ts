/**
 * DefaultProjectScanner: canonicalizes user-selected directories into ProjectDescriptors and runs every
 * registered provider's scan. Strictly read-only. One broken provider never kills the scan.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  ProviderScanResult as ProviderScanResultSchema,
  type ProjectDescriptor,
  type ProjectScanResult,
  type ProviderScanResult,
  type ScanSession,
  type ScannedArtifact,
} from '@devmig/model'
import {
  MigrationError,
  canonicalizePath,
  expandHome,
  isPathWithin,
  newId,
  realPath,
  stableId,
  throwIfAborted,
} from '@devmig/shared'
import type { ProjectScanner, ScanOptions } from '../api'
import { errorMessage, makeBaseContext } from '../context'
import type { Environment } from '../environment'
import { readProjectGitInfo } from '../git/git-info'
import type { JobRunContext } from '../jobs/job-manager'
import type { MigrationProvider, ScanContext } from '../providers/contract'
import type { ProviderRegistry } from '../providers/registry'

export interface DefaultProjectScannerOptions {
  env: Environment
  registry: ProviderRegistry
}

export class DefaultProjectScanner implements ProjectScanner {
  private readonly env: Environment
  private readonly registry: ProviderRegistry
  private readonly sessions = new Map<string, ScanSession>()

  constructor(options: DefaultProjectScannerOptions) {
    this.env = options.env
    this.registry = options.registry
  }

  async describeProject(selectedPath: string, ctx: JobRunContext): Promise<ProjectDescriptor> {
    const trimmed = selectedPath.trim()
    if (trimmed === '') {
      throw new MigrationError('INVALID_INPUT', 'Project path must not be empty.')
    }
    const expanded = expandHome(trimmed, this.env.homeDir)
    if (!path.isAbsolute(expanded)) {
      throw new MigrationError('INVALID_INPUT', `Project path must be absolute: ${selectedPath}`, {
        details: { path: selectedPath },
      })
    }
    const canonicalPath = canonicalizePath(expanded, this.env.homeDir)
    let stat
    try {
      stat = await fs.stat(canonicalPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new MigrationError('PATH_NOT_FOUND', `Directory not found: ${canonicalPath}`, {
          details: { path: canonicalPath },
          hint: 'Choose an existing project directory.',
        })
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new MigrationError('PERMISSION_DENIED', `Cannot access ${canonicalPath}`, {
          details: { path: canonicalPath },
        })
      }
      throw new MigrationError('IO_ERROR', `Cannot stat ${canonicalPath}: ${errorMessage(err)}`, {
        details: { path: canonicalPath },
        cause: err,
      })
    }
    if (!stat.isDirectory()) {
      throw new MigrationError('NOT_A_DIRECTORY', `Not a directory: ${canonicalPath}`, {
        details: { path: canonicalPath },
        hint: 'Select the project folder, not a file inside it.',
      })
    }
    const real = await realPath(canonicalPath, this.env.homeDir)
    const git = await readProjectGitInfo(real, this.env.exec, {
      signal: ctx.signal,
      logger: ctx.logger,
    })
    const descriptor: ProjectDescriptor = {
      id: stableId(real),
      name: path.basename(real) || real,
      originalPath: selectedPath,
      canonicalPath,
      realPath: real,
      detectedProviders: [],
    }
    if (git) descriptor.git = git
    return descriptor
  }

  async scan(paths: string[], options: ScanOptions, ctx: JobRunContext): Promise<ScanSession> {
    const sessionId = newId('scan')
    const warnings: string[] = []
    ctx.setPhase('DISCOVERING', 'Discovering projects…')

    // 1. Canonicalize + dedupe (by real path)
    const projects: ProjectDescriptor[] = []
    const byRealPath = new Map<string, ProjectDescriptor>()
    for (const [index, selected] of paths.entries()) {
      throwIfAborted(ctx.signal)
      ctx.progress(`Inspecting ${selected}`, {
        progress: paths.length > 0 ? index / paths.length : undefined,
      })
      const descriptor = await this.describeProject(selected, ctx)
      const existing = byRealPath.get(descriptor.realPath)
      if (existing) {
        warnings.push(
          `"${selected}" resolves to the same directory as "${existing.originalPath}" and was skipped.`,
        )
        continue
      }
      byRealPath.set(descriptor.realPath, descriptor)
      projects.push(descriptor)
    }

    // 2. Nested / worktree relationships: keep both, warn.
    for (const a of projects) {
      for (const b of projects) {
        if (a === b) continue
        if (isPathWithin(a.realPath, b.realPath)) {
          warnings.push(
            `"${b.name}" (${b.realPath}) is inside "${a.name}" (${a.realPath}); both will be backed up and some data may be included twice.`,
          )
        } else if (a.git?.worktrees.some((w) => !w.isPrimary && w.path === b.realPath)) {
          warnings.push(
            `"${b.name}" (${b.realPath}) is a Git worktree of "${a.name}"; both are selected, so repository data may be captured twice.`,
          )
        }
      }
    }

    // 3. Provider scans
    ctx.setPhase('SCANNING', 'Scanning projects…')
    const providers = this.registry.all()
    const seenArtifactIds = new Set<string>()
    const projectResults: ProjectScanResult[] = []
    const totalUnits =
      projects.length * providers.length + (options.includeGlobal ? providers.length : 0)
    let doneUnits = 0
    const tick = (
      message: string,
      attribution: { projectId?: string; providerId?: string },
    ): void => {
      doneUnits += 1
      ctx.progress(message, {
        progress: totalUnits > 0 ? doneUnits / totalUnits : undefined,
        ...attribution,
      })
    }

    for (const project of projects) {
      const results: ProviderScanResult[] = []
      const projectWarnings: string[] = []
      for (const provider of providers) {
        throwIfAborted(ctx.signal)
        const scanCtx: ScanContext = {
          ...makeBaseContext(this.env, ctx, { projectId: project.id, providerId: provider.id }),
          allProjects: projects,
        }
        ctx.progress(`Scanning ${project.name} with ${provider.displayName}…`, {
          projectId: project.id,
          providerId: provider.id,
        })
        const result = await this.runProviderScan(
          provider,
          () => provider.scanProject(project, scanCtx),
          project.id,
          seenArtifactIds,
          ctx,
        )
        results.push(result)
        projectWarnings.push(...result.warnings.map((w) => `${provider.displayName}: ${w}`))
        tick(`${provider.displayName}: ${result.detected ? 'detected' : 'nothing to migrate'}`, {
          projectId: project.id,
          providerId: provider.id,
        })
      }
      project.detectedProviders = results.filter((r) => r.detected).map((r) => r.providerId)
      projectResults.push({
        project,
        providers: results,
        estimatedBytes: results.reduce((sum, r) => sum + r.estimatedBytes, 0),
        warnings: projectWarnings,
      })
    }

    const globalResults: ProviderScanResult[] = []
    if (options.includeGlobal) {
      for (const provider of providers) {
        throwIfAborted(ctx.signal)
        if (!provider.supportsGlobal || !provider.scanGlobal) {
          tick(`${provider.displayName}: no user-wide state`, { providerId: provider.id })
          continue
        }
        const scanCtx: ScanContext = {
          ...makeBaseContext(this.env, ctx, { providerId: provider.id }),
          allProjects: projects,
        }
        ctx.progress(`Scanning user-wide ${provider.displayName} state…`, {
          providerId: provider.id,
        })
        const result = await this.runProviderScan(
          provider,
          () => provider.scanGlobal!(scanCtx),
          undefined,
          seenArtifactIds,
          ctx,
        )
        globalResults.push(result)
        tick(`${provider.displayName}: ${result.detected ? 'detected' : 'nothing to migrate'}`, {
          providerId: provider.id,
        })
      }
    }

    const session: ScanSession = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      projects: projectResults,
      global: globalResults,
      warnings,
    }
    this.sessions.set(sessionId, session)
    ctx.progress(`Scanned ${projects.length} project(s)`, { progress: 1 })
    return session
  }

  getSession(scanId: string): ScanSession | undefined {
    return this.sessions.get(scanId)
  }

  private async runProviderScan(
    provider: MigrationProvider,
    invoke: () => Promise<ProviderScanResult>,
    projectId: string | undefined,
    seenArtifactIds: Set<string>,
    ctx: JobRunContext,
  ): Promise<ProviderScanResult> {
    let raw: ProviderScanResult
    try {
      raw = await invoke()
    } catch (err) {
      if (ctx.signal.aborted) throw err
      const message = errorMessage(err)
      ctx.logger.warn('Provider scan failed', {
        providerId: provider.id,
        projectId,
        error: message,
      })
      ctx.progress(`${provider.displayName} could not scan: ${message}`, {
        level: 'warn',
        providerId: provider.id,
        ...(projectId ? { projectId } : {}),
      })
      return {
        providerId: provider.id,
        ...(projectId ? { projectId } : {}),
        detected: false,
        artifacts: [],
        summary: [],
        warnings: [`Scan failed: ${message}`],
        estimatedBytes: 0,
      }
    }
    const parsed = ProviderScanResultSchema.safeParse(raw)
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      ctx.logger.warn('Provider returned an invalid scan result', {
        providerId: provider.id,
        projectId,
        error: message,
      })
      return {
        providerId: provider.id,
        ...(projectId ? { projectId } : {}),
        detected: false,
        artifacts: [],
        summary: [],
        warnings: [`Scan result was invalid and has been ignored: ${message}`],
        estimatedBytes: 0,
      }
    }
    const result = parsed.data
    result.providerId = provider.id
    if (projectId) result.projectId = projectId
    result.artifacts = result.artifacts.map((artifact) =>
      normalizeArtifact(artifact, provider.id, projectId, seenArtifactIds),
    )
    return result
  }
}

function normalizeArtifact(
  artifact: ScannedArtifact,
  providerId: string,
  projectId: string | undefined,
  seen: Set<string>,
): ScannedArtifact {
  const prefix = `${providerId}:`
  const id = artifact.id.startsWith(prefix) ? artifact.id : `${prefix}${artifact.id}`
  if (seen.has(id)) {
    throw new MigrationError(
      'PROVIDER_FAILED',
      `Provider "${providerId}" produced a duplicate artifact id: ${id}. Artifact ids must be unique across the scan session.`,
      { details: { providerId, artifactId: id, projectId } },
    )
  }
  seen.add(id)
  const normalized: ScannedArtifact = { ...artifact, id, providerId }
  if (projectId && !normalized.projectId) normalized.projectId = projectId
  return normalized
}
