/**
 * Builds the core services for the desktop app: real Exec, the four providers in their fixed order,
 * and the engines from @devmig/core. Overrides (home dir, Claude config dir) are only supplied by the
 * E2E harness (see e2e.ts); production always derives them from the real environment.
 */
import {
  ProviderRegistry,
  createCoreServices,
  createEnvironment,
  type CoreServices,
  type Environment,
} from '@devmig/core'
import { createClaudeCodeProvider } from '@devmig/provider-claude-code'
import { createGitProvider } from '@devmig/provider-git'
import { createProjectFilesProvider } from '@devmig/provider-project-files'
import { createRuntimeProvider } from '@devmig/provider-runtime'
import { realExec, type Logger } from '@devmig/shared'

export interface EnvironmentOverrides {
  homeDir?: string | null
  claudeConfigDir?: string | null
  claudeJsonPath?: string | null
}

export interface AppCoreOptions {
  logger: Logger
  appVersion: string
  workDir: string
  overrides?: EnvironmentOverrides
}

export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(createGitProvider())
    .register(createProjectFilesProvider())
    .register(createClaudeCodeProvider())
    .register(createRuntimeProvider())
}

export function createAppEnvironment(
  logger: Logger,
  overrides: EnvironmentOverrides = {},
): Environment {
  return createEnvironment({
    logger,
    exec: realExec,
    ...(overrides.homeDir ? { homeDir: overrides.homeDir } : {}),
    ...(overrides.claudeConfigDir ? { claudeConfigDir: overrides.claudeConfigDir } : {}),
    ...(overrides.claudeJsonPath ? { claudeJsonPath: overrides.claudeJsonPath } : {}),
  })
}

export function createAppCore(options: AppCoreOptions): CoreServices {
  const env = createAppEnvironment(options.logger, options.overrides)
  const registry = createProviderRegistry()
  return createCoreServices({
    env,
    registry,
    appVersion: options.appVersion,
    workDir: options.workDir,
  })
}
