/**
 * Builds provider contexts (BaseContext and friends) from the Environment and a JobRunContext.
 * Progress calls are forwarded to the job with project/provider attribution.
 */
import type { Environment } from './environment'
import type { JobRunContext } from './jobs/job-manager'
import type { BaseContext, DetectionContext } from './providers/contract'

export interface ContextAttribution {
  projectId?: string
  providerId?: string
}

export function makeBaseContext(
  env: Environment,
  job: JobRunContext,
  attribution: ContextAttribution = {},
): BaseContext {
  const logger = job.logger.child({
    ...(attribution.projectId ? { projectId: attribution.projectId } : {}),
    ...(attribution.providerId ? { providerId: attribution.providerId } : {}),
  })
  return {
    homeDir: env.homeDir,
    claudeConfigDir: env.claudeConfigDir,
    claudeJsonPath: env.claudeJsonPath,
    env: env.env,
    exec: env.exec,
    logger,
    signal: job.signal,
    progress: (message, fraction, item) => {
      job.progress(message, {
        ...(fraction !== undefined ? { progress: clamp01(fraction) } : {}),
        ...(item ? { item } : {}),
        ...(attribution.projectId ? { projectId: attribution.projectId } : {}),
        ...(attribution.providerId ? { providerId: attribution.providerId } : {}),
      })
    },
  }
}

export function makeDetectionContext(env: Environment, signal?: AbortSignal): DetectionContext {
  return {
    homeDir: env.homeDir,
    claudeConfigDir: env.claudeConfigDir,
    claudeJsonPath: env.claudeJsonPath,
    env: env.env,
    exec: env.exec,
    logger: env.logger,
    ...(signal ? { signal } : {}),
  }
}

/** A JobRunContext for callers that are not running inside a job (previewRemap, inspect). */
export function detachedJobContext(env: Environment, signal?: AbortSignal): JobRunContext {
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return {
    jobId: 'detached',
    signal: controller.signal,
    logger: env.logger,
    progress: () => {},
    setPhase: () => {},
  }
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
