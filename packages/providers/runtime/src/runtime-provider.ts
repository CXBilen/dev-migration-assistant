/**
 * @devmig/provider-runtime — informational provider describing the development runtime.
 *
 * Global: tool versions on the source machine (Node, package managers, Git, Claude Code, GitHub CLI…).
 * Project: package manager, workspace, engines, Node version pin and frameworks from the project root.
 * Restore writes nothing: it compares the source with the destination and reports what to install or
 * re-authenticate, with structured remediations (display only in v0.1).
 */
import path from 'node:path'
import {
  collectMachineInfo,
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
  MachineInfo,
  ManifestArtifact,
  PreflightCheck,
  ProjectDescriptor,
  ProviderScanResult,
  ResultItem,
  ScannedArtifact,
  SummaryItem,
  VerificationCheck,
} from '@devmig/model'
import {
  MigrationError,
  displayPath,
  isMigrationError,
  readJsonFile,
  safeJoin,
  throwIfAborted,
  type Exec,
} from '@devmig/shared'
import {
  RUNTIME_PROVIDER_ID,
  compareMachines,
  compareProjectRuntime,
  type GhAuthStatus,
} from './compare'
import { detectProjectRuntime, hasRuntimeHints, summarizeProjectRuntime } from './project-runtime'
import type { Remediation } from './remediation'
import {
  MachineArtifactMeta,
  PlanState,
  ProjectArtifactMeta,
  ProjectRuntimePayload,
  type RestoreState,
  RuntimeMachinePayload,
} from './schema'
import { displayVersion, toolLabel } from './versions'

export { RUNTIME_PROVIDER_ID }
export const RUNTIME_SCHEMA_VERSION = 1
export const RUNTIME_PROVIDER_VERSION = '0.1.0'
export const MACHINE_ARTIFACT_ID = `${RUNTIME_PROVIDER_ID}:machine`
export const MACHINE_PAYLOAD_FILE = 'runtime.json'
export const PROJECT_PAYLOAD_FILE = 'project-runtime.json'

const GH_AUTH_TIMEOUT_MS = 10_000

export function projectArtifactId(projectId: string): string {
  return `${RUNTIME_PROVIDER_ID}:project:${projectId}`
}

/** Summary rows for a machine: "Node 22.22.3" (ok) or "Bun not installed" (info). */
export function summarizeMachine(machine: MachineInfo): SummaryItem[] {
  const rows: SummaryItem[] = []
  for (const tool of machine.tools) {
    const label = toolLabel(tool.id, tool.label)
    if (tool.installed) {
      const version = displayVersion(tool.version)
      rows.push({ label: version ? `${label} ${version}` : label, status: 'ok' })
    } else {
      rows.push({ label: `${label} not installed`, status: 'info' })
    }
  }
  const os = machine.platform === 'darwin' ? 'macOS' : machine.platform
  rows.push({
    label: `${os}${machine.osVersion ? ` ${machine.osVersion}` : ''} · ${machine.arch}`,
    status: 'info',
  })
  return rows
}

async function probeDestination(ctx: {
  exec: Exec
  homeDir: string
  env: Record<string, string | undefined>
  signal: AbortSignal
}): Promise<MachineInfo> {
  return collectMachineInfo(ctx.exec, { homeDir: ctx.homeDir, env: ctx.env, signal: ctx.signal })
}

/** `gh auth status`: exit 0 = logged in, exit 1 = not logged in, anything else = could not verify. */
export async function probeGhAuth(
  exec: Exec,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
  installed: boolean,
): Promise<GhAuthStatus> {
  if (!installed) return 'not-installed'
  try {
    const result = await exec('gh', ['auth', 'status'], {
      reject: false,
      timeoutMs: GH_AUTH_TIMEOUT_MS,
      env,
      signal,
    })
    if (result.exitCode === 0) return 'ok'
    if (result.exitCode === 1) return 'unauthenticated'
    return 'unavailable'
  } catch (err) {
    if (isMigrationError(err) && err.code === 'CANCELLED') throw err
    return 'unavailable'
  }
}

function statusToCheck(status: ResultItem['status']): VerificationCheck['status'] {
  return status === 'error' ? 'fail' : status === 'warn' ? 'warn' : 'pass'
}

function checkIdFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export class RuntimeProvider implements MigrationProvider {
  readonly id = RUNTIME_PROVIDER_ID
  readonly displayName = 'Development runtime'
  readonly version = RUNTIME_PROVIDER_VERSION
  readonly schemaVersion = RUNTIME_SCHEMA_VERSION
  readonly supportsGlobal = true

  async detect(ctx: DetectionContext): Promise<ProviderDetection> {
    const machine = await collectMachineInfo(ctx.exec, {
      homeDir: ctx.homeDir,
      env: ctx.env,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    const details: Record<string, string> = {}
    for (const tool of machine.tools) {
      details[tool.id] = tool.installed
        ? (displayVersion(tool.version) ?? 'installed')
        : 'not installed'
    }
    return { providerId: this.id, available: true, version: this.version, details, notes: [] }
  }

  async scanGlobal(ctx: ScanContext): Promise<ProviderScanResult> {
    ctx.progress('Probing installed development tools…')
    const machine = await probeDestination(ctx)
    const size = Buffer.byteLength(JSON.stringify(machine))
    const artifact: ScannedArtifact = {
      id: MACHINE_ARTIFACT_ID,
      providerId: this.id,
      scope: 'user',
      kind: 'json-fragment',
      label: 'Development runtime (tool versions)',
      description:
        'Node, package managers, Git, Claude Code and GitHub CLI versions — informational.',
      sourcePath: displayPath(ctx.homeDir, ctx.homeDir),
      sizeBytes: size,
      count: machine.tools.filter((t) => t.installed).length,
      sensitivity: 'safe',
      includedByDefault: true,
      selectable: true,
      reasons: [],
      meta: { machine },
    }
    return {
      providerId: this.id,
      detected: true,
      artifacts: [artifact],
      summary: summarizeMachine(machine),
      warnings: [],
      estimatedBytes: size,
    }
  }

  async scanProject(project: ProjectDescriptor, ctx: ScanContext): Promise<ProviderScanResult> {
    ctx.progress(`Reading runtime hints in ${project.name}…`)
    const { runtime, warnings } = await detectProjectRuntime(project.realPath, ctx.signal)
    if (!hasRuntimeHints(runtime)) {
      return {
        providerId: this.id,
        projectId: project.id,
        detected: false,
        artifacts: [],
        summary: [
          {
            label: 'No runtime hints found',
            status: 'info',
            detail: 'no package.json, lockfile or Node version pin',
          },
        ],
        warnings,
        estimatedBytes: 0,
      }
    }
    const size = Buffer.byteLength(JSON.stringify(runtime))
    const parts: string[] = []
    if (runtime.packageManager) {
      parts.push(
        runtime.packageManager.version
          ? `${runtime.packageManager.id} ${runtime.packageManager.version}`
          : runtime.packageManager.id,
      )
    }
    if (runtime.nodePin) parts.push(`Node ${runtime.nodePin.raw}`)
    for (const f of runtime.frameworks)
      parts.push(f.major !== null ? `${f.label} ${f.major}.x` : f.label)
    const artifact: ScannedArtifact = {
      id: projectArtifactId(project.id),
      providerId: this.id,
      projectId: project.id,
      scope: 'project',
      kind: 'json-fragment',
      label: 'Tool versions (package manager, Node, frameworks)',
      description: parts.join(' · ') || undefined,
      sourcePath: displayPath(project.realPath, ctx.homeDir),
      sizeBytes: size,
      sensitivity: 'safe',
      includedByDefault: true,
      selectable: true,
      reasons: [],
      meta: { runtime, projectPath: project.realPath },
    }
    return {
      providerId: this.id,
      projectId: project.id,
      detected: true,
      artifacts: [artifact],
      summary: summarizeProjectRuntime(runtime),
      warnings,
      estimatedBytes: size,
    }
  }

  async createBackupArtifacts(
    input: ProviderBackupInput,
    ctx: BackupContext,
  ): Promise<ProviderBackupOutput> {
    const artifacts: ManifestArtifact[] = []
    const summary: Record<string, unknown> = {}
    for (const artifact of input.artifacts) {
      throwIfAborted(ctx.signal)
      if (artifact.id === MACHINE_ARTIFACT_ID) {
        const meta = MachineArtifactMeta.safeParse(artifact.meta)
        if (!meta.success) {
          throw new MigrationError(
            'PROVIDER_FAILED',
            'Machine runtime artifact carries invalid metadata.',
            {
              details: { artifactId: artifact.id },
            },
          )
        }
        const payload: RuntimeMachinePayload = {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          machine: meta.data.machine,
        }
        const text = `${JSON.stringify(payload, null, 2)}\n`
        await ctx.fs.writeFileAtomic(path.join(ctx.stagingDir, MACHINE_PAYLOAD_FILE), text, 0o600)
        artifacts.push({
          id: artifact.id,
          providerId: this.id,
          kind: 'json-fragment',
          label: artifact.label,
          payloadPath: ctx.payloadPathFor(MACHINE_PAYLOAD_FILE),
          sizeBytes: Buffer.byteLength(text),
          fileCount: 1,
          sensitivity: 'safe',
          meta: { kind: 'machine' },
        })
        summary.tools = Object.fromEntries(
          meta.data.machine.tools.map((t) => [
            t.id,
            t.installed ? (displayVersion(t.version) ?? 'installed') : null,
          ]),
        )
        ctx.progress('Captured tool versions', undefined, {
          id: artifact.id,
          label: artifact.label,
          status: 'done',
        })
        continue
      }
      const meta = ProjectArtifactMeta.safeParse(artifact.meta)
      if (!meta.success || !input.project) {
        throw new MigrationError(
          'PROVIDER_FAILED',
          `Runtime artifact ${artifact.id} carries invalid metadata.`,
          {
            details: { artifactId: artifact.id },
          },
        )
      }
      const payload: ProjectRuntimePayload = {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        projectPath: meta.data.projectPath,
        runtime: meta.data.runtime,
      }
      const text = `${JSON.stringify(payload, null, 2)}\n`
      await ctx.fs.writeFileAtomic(path.join(ctx.stagingDir, PROJECT_PAYLOAD_FILE), text, 0o600)
      artifacts.push({
        id: artifact.id,
        providerId: this.id,
        kind: 'json-fragment',
        label: artifact.label,
        payloadPath: ctx.payloadPathFor(PROJECT_PAYLOAD_FILE),
        sizeBytes: Buffer.byteLength(text),
        fileCount: 1,
        sensitivity: 'safe',
        sourcePath: meta.data.projectPath,
        meta: { kind: 'project' },
      })
      summary.packageManager = meta.data.runtime.packageManager?.id ?? null
      summary.nodePin = meta.data.runtime.nodePin?.raw ?? null
      summary.frameworks = meta.data.runtime.frameworks.map((f) => f.id)
      ctx.progress('Captured project runtime', undefined, {
        id: artifact.id,
        label: artifact.label,
        status: 'done',
      })
    }
    return { artifacts, schemaVersion: this.schemaVersion, summary }
  }

  private async readMachinePayload(
    payloadRoot: string,
    payloadPath: string,
  ): Promise<RuntimeMachinePayload> {
    const file = safeJoin(payloadRoot, payloadPath)
    const parsed = RuntimeMachinePayload.safeParse(await readJsonFile(file).catch(() => null))
    if (!parsed.success) {
      throw new MigrationError(
        'ARCHIVE_INVALID',
        'runtime.json in the backup is missing or invalid.',
        {
          details: { payloadPath },
        },
      )
    }
    return parsed.data
  }

  private async readProjectPayload(
    payloadRoot: string,
    payloadPath: string,
  ): Promise<ProjectRuntimePayload> {
    const file = safeJoin(payloadRoot, payloadPath)
    const parsed = ProjectRuntimePayload.safeParse(await readJsonFile(file).catch(() => null))
    if (!parsed.success) {
      throw new MigrationError(
        'ARCHIVE_INVALID',
        'project-runtime.json in the backup is missing or invalid.',
        {
          details: { payloadPath },
        },
      )
    }
    return parsed.data
  }

  async planRestore(
    input: ProviderRestoreInput,
    ctx: RestorePlanningContext,
  ): Promise<ProviderRestorePlan> {
    const artifact = input.artifacts[0]
    const empty: ProviderRestorePlan = {
      providerId: this.id,
      ...(input.project ? { projectId: input.project.id } : {}),
      steps: [],
      collisions: [],
      preflight: [],
      remap: { affected: [], safeRewriteCount: 0, warnings: [], unsupportedReferences: [] },
      warnings: [],
      state: {},
    }
    if (!artifact) return empty
    const kind = input.project ? 'project' : 'machine'
    const preflight: PreflightCheck[] = []
    const destination = await probeDestination(ctx)
    if (kind === 'machine') {
      const payload = await this.readMachinePayload(ctx.payloadRoot, artifact.payloadPath)
      const ghInstalled = destination.tools.some((t) => t.id === 'gh' && t.installed)
      const comparison = compareMachines(
        payload.machine,
        destination,
        await probeGhAuth(ctx.exec, ctx.env, ctx.signal, ghInstalled),
      )
      for (const item of comparison.items) {
        preflight.push({
          id: `check:${checkIdFor(item.label)}`,
          label: item.label,
          status: statusToCheck(item.status),
          ...(item.detail ? { detail: item.detail } : {}),
          blocking: false,
        })
      }
    } else {
      const payload = await this.readProjectPayload(ctx.payloadRoot, artifact.payloadPath)
      const comparison = compareProjectRuntime(
        input.project?.id ?? 'project',
        payload.runtime,
        destination,
      )
      for (const item of comparison.items) {
        preflight.push({
          id: `check:${checkIdFor(item.label)}`,
          label: item.label,
          status: statusToCheck(item.status),
          ...(item.detail ? { detail: item.detail } : {}),
          blocking: false,
        })
      }
    }
    const state: PlanState = { kind, payloadPath: artifact.payloadPath }
    return {
      ...empty,
      steps: [
        {
          id: `compare:${kind}`,
          providerId: this.id,
          ...(input.project ? { projectId: input.project.id } : {}),
          label:
            kind === 'machine'
              ? 'Compare development tools with this Mac'
              : `Check the runtime ${input.project?.name ?? 'the project'} expects`,
          detail: 'Nothing is written; differences are reported with suggested fixes.',
          artifactIds: [artifact.id],
        },
      ],
      preflight,
      state,
    }
  }

  async restore(
    plan: ProviderRestorePlan,
    input: ProviderRestoreInput,
    ctx: RestoreContext,
  ): Promise<ProviderRestoreResult> {
    const parsed = PlanState.safeParse(plan.state)
    if (!parsed.success) {
      return {
        providerId: this.id,
        ...(input.project ? { projectId: input.project.id } : {}),
        status: 'skipped',
        items: [{ label: 'Nothing to compare', status: 'info' }],
        warnings: [],
      }
    }
    throwIfAborted(ctx.signal)
    ctx.progress('Probing installed development tools…')
    const destination = await probeDestination(ctx)
    let comparison
    if (parsed.data.kind === 'machine') {
      const payload = await this.readMachinePayload(ctx.payloadRoot, parsed.data.payloadPath)
      const ghInstalled = destination.tools.some((t) => t.id === 'gh' && t.installed)
      const ghAuth = await probeGhAuth(ctx.exec, ctx.env, ctx.signal, ghInstalled)
      comparison = compareMachines(payload.machine, destination, ghAuth)
    } else {
      const payload = await this.readProjectPayload(ctx.payloadRoot, parsed.data.payloadPath)
      comparison = compareProjectRuntime(
        input.project?.id ?? 'project',
        payload.runtime,
        destination,
      )
    }
    const state: RestoreState = { remediations: comparison.remediations satisfies Remediation[] }
    return {
      providerId: this.id,
      ...(input.project ? { projectId: input.project.id } : {}),
      status: 'ok',
      items: comparison.items,
      warnings: [],
      attention: comparison.attention,
      state,
    }
  }

  async verify(input: ProviderVerifyInput, ctx: VerifyContext): Promise<ProviderVerification> {
    throwIfAborted(ctx.signal)
    const checks: VerificationCheck[] = []
    const kind = PlanState.safeParse(input.plan.state)
    if (kind.success) {
      const file = safeJoin(ctx.payloadRoot, kind.data.payloadPath)
      const ok = await readJsonFile(file)
        .then(
          (json) =>
            (kind.data.kind === 'machine'
              ? RuntimeMachinePayload
              : ProjectRuntimePayload
            ).safeParse(json).success,
        )
        .catch(() => false)
      checks.push({
        id: `payload:${kind.data.kind}`,
        label:
          kind.data.kind === 'machine'
            ? 'Source tool versions readable'
            : 'Project runtime hints readable',
        status: ok ? 'pass' : 'fail',
      })
    }
    for (const item of input.result.items) {
      checks.push({
        id: `item:${checkIdFor(item.label)}`,
        label: item.label,
        status: statusToCheck(item.status),
        ...(item.detail ? { detail: item.detail } : {}),
      })
    }
    return { checks }
  }
}

export function createRuntimeProvider(): MigrationProvider {
  return new RuntimeProvider()
}
