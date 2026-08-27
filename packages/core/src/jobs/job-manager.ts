import { EventEmitter } from 'node:events'
import type { JobKind, JobSnapshot, JobStatus, ProgressEvent } from '@devmig/model'
import { MigrationError, newId, serializeError, type Logger } from '@devmig/shared'

export interface JobRunContext {
  jobId: string
  signal: AbortSignal
  logger: Logger
  /** Emit a progress event. Phase transitions use setPhase(). */
  progress: (
    message: string,
    opts?: Partial<Omit<ProgressEvent, 'jobId' | 'message' | 'at'>>,
  ) => void
  setPhase: (phase: string, message?: string) => void
}

export type JobRunner<T> = (ctx: JobRunContext) => Promise<T>

export interface JobEvents {
  progress: [ProgressEvent]
  state: [JobSnapshot]
}

const MAX_RECENT_EVENTS = 200

/**
 * Minimal job engine: one AbortController per job, structured progress events, snapshots for late subscribers.
 * UI-agnostic. The Electron main process bridges `progress`/`state` events to the renderer.
 */
export class JobManager extends EventEmitter<JobEvents> {
  private readonly jobs = new Map<
    string,
    { snapshot: JobSnapshot; controller: AbortController; promise: Promise<unknown> }
  >()

  constructor(private readonly logger: Logger) {
    super()
  }

  start<T>(kind: JobKind, runner: JobRunner<T>, initialPhase = 'IDLE'): JobSnapshot {
    const id = newId('job')
    const controller = new AbortController()
    const snapshot: JobSnapshot = {
      id,
      kind,
      status: 'running',
      phase: initialPhase,
      message: 'Starting…',
      startedAt: new Date().toISOString(),
      recentEvents: [],
    }
    const entry = { snapshot, controller, promise: Promise.resolve() as Promise<unknown> }
    this.jobs.set(id, entry)
    const jobLogger = this.logger.child({ jobId: id, jobKind: kind })

    const emitProgress = (
      message: string,
      opts: Partial<Omit<ProgressEvent, 'jobId' | 'message' | 'at'>> = {},
    ): void => {
      const event: ProgressEvent = {
        jobId: id,
        phase: opts.phase ?? snapshot.phase,
        message,
        level: opts.level ?? 'info',
        at: new Date().toISOString(),
        ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.providerId ? { providerId: opts.providerId } : {}),
        ...(opts.item ? { item: opts.item } : {}),
      }
      snapshot.message = message
      if (opts.progress !== undefined) snapshot.progress = opts.progress
      snapshot.recentEvents.push(event)
      if (snapshot.recentEvents.length > MAX_RECENT_EVENTS)
        snapshot.recentEvents.splice(0, snapshot.recentEvents.length - MAX_RECENT_EVENTS)
      jobLogger[event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info'](
        message,
        {
          phase: event.phase,
          projectId: event.projectId,
          providerId: event.providerId,
        },
      )
      this.emit('progress', event)
    }

    const setPhase = (phase: string, message?: string): void => {
      snapshot.phase = phase
      snapshot.progress = undefined
      emitProgress(message ?? phase, { phase })
      this.emit('state', structuredClone(snapshot))
    }

    const ctx: JobRunContext = {
      jobId: id,
      signal: controller.signal,
      logger: jobLogger,
      progress: emitProgress,
      setPhase,
    }

    entry.promise = runner(ctx)
      .then((result) => {
        snapshot.status = 'completed'
        snapshot.result = result
        snapshot.finishedAt = new Date().toISOString()
        snapshot.phase = 'COMPLETE'
        emitProgress('Completed', { phase: 'COMPLETE', progress: 1 })
      })
      .catch((err: unknown) => {
        const serialized = serializeError(err)
        snapshot.status =
          controller.signal.aborted || serialized.code === 'CANCELLED' ? 'cancelled' : 'failed'
        snapshot.error = serialized
        snapshot.finishedAt = new Date().toISOString()
        snapshot.phase = snapshot.status === 'cancelled' ? 'CANCELLED' : 'FAILED'
        emitProgress(serialized.message, {
          phase: snapshot.phase,
          level: snapshot.status === 'cancelled' ? 'warn' : 'error',
        })
        jobLogger.error('Job ended with error', {
          code: serialized.code,
          details: serialized.details,
        })
      })
      .finally(() => {
        this.emit('state', structuredClone(snapshot))
      })

    this.emit('state', structuredClone(snapshot))
    return structuredClone(snapshot)
  }

  get(jobId: string): JobSnapshot {
    const entry = this.jobs.get(jobId)
    if (!entry) throw new MigrationError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    return structuredClone(entry.snapshot)
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((e) => structuredClone(e.snapshot))
  }

  cancel(jobId: string): JobSnapshot {
    const entry = this.jobs.get(jobId)
    if (!entry) throw new MigrationError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    if (entry.snapshot.status !== 'running' && entry.snapshot.status !== 'queued') {
      throw new MigrationError('JOB_ALREADY_FINISHED', `Job already finished: ${jobId}`)
    }
    entry.controller.abort()
    return structuredClone(entry.snapshot)
  }

  /** Awaits completion (resolves with the final snapshot, never rejects). */
  async wait(jobId: string): Promise<JobSnapshot> {
    const entry = this.jobs.get(jobId)
    if (!entry) throw new MigrationError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    await entry.promise
    return structuredClone(entry.snapshot)
  }

  /** Waits and returns the typed result, throwing the serialized error on failure. */
  async result<T>(jobId: string): Promise<T> {
    const snap = await this.wait(jobId)
    if (snap.status !== 'completed') {
      throw new MigrationError(snap.error?.code ?? 'UNKNOWN', snap.error?.message ?? 'Job failed', {
        details: snap.error?.details,
        hint: snap.error?.hint,
      })
    }
    return snap.result as T
  }

  status(jobId: string): JobStatus {
    return this.get(jobId).status
  }
}
