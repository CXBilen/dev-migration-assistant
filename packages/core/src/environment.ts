import os from 'node:os'
import path from 'node:path'
import { realExec, type Exec, type Logger } from '@devmig/shared'
import {
  joinSearchPath,
  nodeSearchPathIo,
  resolveSearchPath,
  type SearchPathIo,
} from './search-path'

/** Facts about where things live for the current user. Tests construct these pointing at temp dirs. */
export interface Environment {
  homeDir: string
  claudeConfigDir: string
  claudeJsonPath: string
  env: Record<string, string | undefined>
  exec: Exec
  logger: Logger
}

/** Resolves the Claude config dir exactly as Claude Code does: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function resolveClaudeConfigDir(
  homeDir: string,
  env: Record<string, string | undefined>,
): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(homeDir, '.claude')
}

/**
 * ~/.claude.json lives next to the home dir by default. When CLAUDE_CONFIG_DIR is set, Claude Code stores
 * the file inside that directory as `.claude.json` (see docs/research/claude-code-storage.md).
 */
export function resolveClaudeJsonPath(
  homeDir: string,
  claudeConfigDir: string,
  env: Record<string, string | undefined>,
): string {
  if (env.CLAUDE_CONFIG_DIR?.trim()) return path.join(claudeConfigDir, '.claude.json')
  return path.join(homeDir, '.claude.json')
}

export interface CreateEnvironmentOverrides extends Partial<Environment> {
  logger: Logger
  /** Injected by tests; defaults to the real filesystem. */
  searchPathIo?: SearchPathIo
  /** When false the PATH of `env` is used verbatim (tests, fixtures). Default true. */
  augmentSearchPath?: boolean
}

/**
 * Builds the Environment. PATH is resolved deterministically (launchd's PATH plus /etc/paths(.d) and
 * the well-known user tool directories that exist — see search-path.ts) because a Finder-launched app
 * does not inherit the shell's PATH. The returned `exec` always forwards this env so every
 * subprocess sees the same PATH; per-call `env` entries win over it.
 */
export function createEnvironment(overrides: CreateEnvironmentOverrides): Environment {
  const homeDir = overrides.homeDir ?? os.homedir()
  const baseEnv = overrides.env ?? { ...process.env }
  const env: Record<string, string | undefined> = { ...baseEnv }
  if (overrides.augmentSearchPath !== false) {
    env.PATH = joinSearchPath(
      resolveSearchPath({
        homeDir,
        basePath: baseEnv.PATH,
        io: overrides.searchPathIo ?? nodeSearchPathIo,
      }),
    )
  }
  const claudeConfigDir = overrides.claudeConfigDir ?? resolveClaudeConfigDir(homeDir, env)
  const claudeJsonPath =
    overrides.claudeJsonPath ?? resolveClaudeJsonPath(homeDir, claudeConfigDir, env)
  const baseExec = overrides.exec ?? realExec
  const exec: Exec = (file, args, options = {}) =>
    baseExec(file, args, { ...options, env: { ...env, ...options.env } })
  return {
    homeDir,
    claudeConfigDir,
    claudeJsonPath,
    env,
    exec,
    logger: overrides.logger,
  }
}
