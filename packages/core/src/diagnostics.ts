/**
 * Diagnostics screen / "Copy diagnostics" content. Contains no secrets: tool versions, provider
 * availability, config-dir existence. Every probe is isolated so a broken provider cannot break the report.
 */
import {
  DEVBACKUP_FORMAT_VERSION,
  Diagnostics as DiagnosticsSchema,
  type Diagnostics,
  type ProviderStatus,
} from '@devmig/model'
import { isDirectory } from '@devmig/shared'
import { errorMessage, makeDetectionContext } from './context'
import type { Environment } from './environment'
import { collectMachineInfo } from './machine/collect-machine-info'
import type { MigrationProvider } from './providers/contract'
import type { ProviderRegistry } from './providers/registry'

export interface DiagnosticsInput {
  appVersion: string
  electronVersion: string | null
  logsDirectory: string
}

export interface CollectDiagnosticsOptions {
  signal?: AbortSignal
  /** Overrides the Node version reported (tests). */
  nodeVersion?: string
}

async function providerStatus(
  provider: MigrationProvider,
  env: Environment,
  signal: AbortSignal | undefined,
): Promise<ProviderStatus> {
  try {
    const detection = await provider.detect(makeDetectionContext(env, signal))
    return {
      id: provider.id,
      displayName: provider.displayName,
      version: provider.version,
      available: detection.available,
      details: {
        ...detection.details,
        ...(detection.version ? { toolVersion: detection.version } : {}),
      },
      notes: [...detection.notes],
    }
  } catch (err) {
    env.logger.warn('Provider detection failed', {
      providerId: provider.id,
      error: errorMessage(err),
    })
    return {
      id: provider.id,
      displayName: provider.displayName,
      version: provider.version,
      available: false,
      details: {},
      notes: [`Detection failed: ${errorMessage(err)}`],
    }
  }
}

export async function collectDiagnostics(
  env: Environment,
  registry: ProviderRegistry,
  input: DiagnosticsInput,
  options: CollectDiagnosticsOptions = {},
): Promise<Diagnostics> {
  const [machine, providers, claudeConfigDirExists] = await Promise.all([
    collectMachineInfo(env.exec, { homeDir: env.homeDir, env: env.env, signal: options.signal }),
    Promise.all(registry.all().map((p) => providerStatus(p, env, options.signal))),
    isDirectory(env.claudeConfigDir),
  ])
  const claudeTool = machine.tools.find((t) => t.id === 'claude')
  return DiagnosticsSchema.parse({
    appVersion: input.appVersion,
    backupFormatVersion: DEVBACKUP_FORMAT_VERSION,
    electronVersion: input.electronVersion,
    nodeVersion: options.nodeVersion ?? process.versions.node,
    machine,
    claudeConfigDir: env.claudeConfigDir,
    claudeConfigDirExists,
    claudeCodeVersion: claudeTool?.installed ? claudeTool.version : null,
    providers,
    logsDirectory: input.logsDirectory,
    generatedAt: new Date().toISOString(),
  } satisfies Diagnostics)
}
