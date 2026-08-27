/**
 * Startup sweep of the private work directory (`<tmp>/devmig`): staging directories left behind by a
 * crashed run are removed. Only entries with the known prefixes are touched, only when they are older
 * than a grace period (another app build may still be using the shared temp root), and only when the
 * work dir itself lives under the OS temp dir or an explicitly allowed root.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPathWithin, type Logger } from '@devmig/shared'

export const WORK_DIR_ENTRY_PREFIXES = ['backup-', 'backup-tmp-', 'restore-'] as const
export const DEFAULT_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000

export interface SweepOptions {
  logger: Logger
  /** Entries younger than this are kept (default 24h). */
  minAgeMs?: number
  now?: () => number
  /** Roots the work dir may live under besides os.tmpdir() (E2E work dirs). */
  allowedRoots?: readonly string[]
}

export interface SweepResult {
  removed: string[]
  skipped: string[]
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p)
  } catch {
    return null
  }
}

export async function sweepWorkDir(workDir: string, options: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { removed: [], skipped: [] }
  const real = await realpathOrNull(workDir)
  if (!real) return result
  const roots = (
    await Promise.all([os.tmpdir(), ...(options.allowedRoots ?? [])].map(realpathOrNull))
  ).filter((r): r is string => typeof r === 'string' && r.length > 0)
  if (!roots.some((root) => isPathWithin(root, real) && real !== root)) {
    options.logger.warn('Refusing to sweep a work dir outside the OS temp dir', { workDir: real })
    return result
  }
  const minAge = options.minAgeMs ?? DEFAULT_SWEEP_MIN_AGE_MS
  const now = options.now ? options.now() : Date.now()
  let entries: string[]
  try {
    entries = await fs.readdir(real)
  } catch {
    return result
  }
  for (const name of entries) {
    if (!WORK_DIR_ENTRY_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const full = path.join(real, name)
    try {
      const st = await fs.lstat(full)
      if (!st.isDirectory()) continue
      if (now - st.mtimeMs < minAge) {
        result.skipped.push(name)
        continue
      }
      await fs.rm(full, { recursive: true, force: true, maxRetries: 2 })
      result.removed.push(name)
    } catch (err) {
      options.logger.warn('Could not remove leftover work dir entry', {
        entry: name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (result.removed.length > 0) {
    options.logger.info('Removed leftover staging directories', {
      count: result.removed.length,
      workDir: real,
    })
  }
  return result
}
