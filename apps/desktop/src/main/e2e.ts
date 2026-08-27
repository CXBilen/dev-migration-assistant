/**
 * E2E test seam configuration. Everything here is inert unless `DEVMIG_E2E=1` is present in the
 * main process environment. Nothing in this module is reachable from the renderer: the values are
 * read once at startup and handed to the services that honour them.
 */
import path from 'node:path'

export interface E2EConfig {
  /** JSON queue file answering native dialogs (see services/e2e-dialog-seam.ts). */
  dialogFile: string | null
  /** Overrides for the Environment (absolute paths). */
  homeDir: string | null
  claudeConfigDir: string | null
  claudeJsonPath: string | null
  /** Private work dir for staging, user data and logs. */
  workDir: string | null
}

function absoluteOrNull(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return null
  return path.resolve(trimmed)
}

/** Returns the E2E configuration, or null when the process is not running under the E2E harness. */
export function readE2EConfig(env: Record<string, string | undefined>): E2EConfig | null {
  if (env.DEVMIG_E2E !== '1') return null
  return {
    dialogFile: absoluteOrNull(env.DEVMIG_E2E_DIALOG_FILE),
    homeDir: absoluteOrNull(env.DEVMIG_E2E_HOME_DIR),
    claudeConfigDir: absoluteOrNull(env.DEVMIG_E2E_CLAUDE_CONFIG_DIR),
    claudeJsonPath: absoluteOrNull(env.DEVMIG_E2E_CLAUDE_JSON_PATH),
    workDir: absoluteOrNull(env.DEVMIG_WORK_DIR),
  }
}
