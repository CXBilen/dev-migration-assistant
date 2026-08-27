/**
 * Asks Git which candidate files it ignores. Only ignored files need to travel with this provider;
 * tracked and untracked-but-not-ignored files are captured by the Git working-tree provider.
 *
 * Paths are fed to `git check-ignore -z --stdin` through stdin (never argv), NUL-separated.
 */
import { isMigrationError, type Exec } from '@devmig/shared'
import { isSafeRelpath } from './candidates'

export interface CheckIgnoreResult {
  /** `ok` when git answered; `unavailable` when git is missing or failed (callers must not assume anything then). */
  status: 'ok' | 'unavailable'
  /** Relative paths git reported as ignored. */
  ignored: Set<string>
  error?: string
}

export const CHECK_IGNORE_TIMEOUT_MS = 30_000

export async function checkIgnored(
  exec: Exec,
  cwd: string,
  relpaths: readonly string[],
  signal?: AbortSignal,
): Promise<CheckIgnoreResult> {
  const safe = relpaths.filter((p) => isSafeRelpath(p))
  if (safe.length === 0) return { status: 'ok', ignored: new Set() }
  try {
    const result = await exec('git', ['check-ignore', '-z', '--stdin'], {
      cwd,
      input: `${safe.join('\0')}\0`,
      reject: false,
      timeoutMs: CHECK_IGNORE_TIMEOUT_MS,
      signal,
    })
    // 0 = at least one path ignored, 1 = none ignored, 128 = fatal error
    if (result.exitCode === 0) {
      return { status: 'ok', ignored: new Set(parseNulList(result.stdout)) }
    }
    if (result.exitCode === 1) return { status: 'ok', ignored: new Set() }
    return {
      status: 'unavailable',
      ignored: new Set(),
      error: `git check-ignore exited with ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}`,
    }
  } catch (err) {
    if (isMigrationError(err) && err.code === 'CANCELLED') throw err
    return {
      status: 'unavailable',
      ignored: new Set(),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Splits NUL-separated output; blank entries are dropped. */
export function parseNulList(text: string): string[] {
  return text.split('\0').filter((entry) => entry.length > 0)
}
