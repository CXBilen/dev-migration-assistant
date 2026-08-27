import os from 'node:os'
import path from 'node:path'
import { realExec, type Exec, type Logger } from '@devmig/shared'

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

export function createEnvironment(
  overrides: Partial<Environment> & { logger: Logger },
): Environment {
  const homeDir = overrides.homeDir ?? os.homedir()
  const env = overrides.env ?? { ...process.env }
  const claudeConfigDir = overrides.claudeConfigDir ?? resolveClaudeConfigDir(homeDir, env)
  const claudeJsonPath =
    overrides.claudeJsonPath ?? resolveClaudeJsonPath(homeDir, claudeConfigDir, env)
  return {
    homeDir,
    claudeConfigDir,
    claudeJsonPath,
    env,
    exec: overrides.exec ?? realExec,
    logger: overrides.logger,
  }
}
