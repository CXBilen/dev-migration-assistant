/**
 * Forwards JobManager events to every renderer window as `jobs:progress` / `jobs:state` pushes.
 * Every payload is validated with the IpcEvents schema before it leaves the main process, and progress
 * events are throttled per job (≤ maxEventsPerSecond, coalescing; the latest event always gets through).
 */
import type { JobManager } from '@devmig/core'
import { IpcEvents, type IpcEventName, type IpcEventPayload } from '@devmig/ipc-contracts'
import type { JobSnapshot, ProgressEvent } from '@devmig/model'
import type { Logger } from '@devmig/shared'

export const DEFAULT_MAX_EVENTS_PER_SECOND = 30
const TERMINAL: ReadonlySet<JobSnapshot['status']> = new Set(['completed', 'failed', 'cancelled'])

export interface JobBridgeOptions {
  jobs: Pick<JobManager, 'on' | 'off'>
  broadcast: <E extends IpcEventName>(channel: E, payload: IpcEventPayload<E>) => void
  logger: Logger
  maxEventsPerSecond?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface JobBridge {
  /** Sends every pending (throttled) progress event immediately. */
  flush(): void
  dispose(): void
}

interface JobThrottleState {
  lastSentAt: number
  pending: ProgressEvent | null
  /** Timer handle from setTimer; null when no timer is pending. */
  timer: unknown
}

export function createJobBridge(options: JobBridgeOptions): JobBridge {
  const logger = options.logger.child({ component: 'job-bridge' })
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout))
  const interval = 1000 / (options.maxEventsPerSecond ?? DEFAULT_MAX_EVENTS_PER_SECOND)
  const states = new Map<string, JobThrottleState>()

  function send<E extends IpcEventName>(channel: E, payload: unknown): boolean {
    const parsed = IpcEvents[channel].safeParse(payload)
    if (!parsed.success) {
      logger.error('Dropped an event that does not match the IpcEvents schema', {
        channel,
        issues: parsed.error.issues.slice(0, 5).map((i) => i.message),
      })
      return false
    }
    try {
      options.broadcast(channel, parsed.data as IpcEventPayload<E>)
    } catch (err) {
      logger.warn('Broadcast failed', {
        channel,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  function stateFor(jobId: string): JobThrottleState {
    let state = states.get(jobId)
    if (!state) {
      state = { lastSentAt: Number.NEGATIVE_INFINITY, pending: null, timer: null }
      states.set(jobId, state)
    }
    return state
  }

  function flushJob(jobId: string, state: JobThrottleState): void {
    if (state.timer !== null) {
      clearTimer(state.timer)
      state.timer = null
    }
    if (state.pending) {
      const event = state.pending
      state.pending = null
      if (send('jobs:progress', event)) state.lastSentAt = now()
    }
    void jobId
  }

  const onProgress = (event: ProgressEvent): void => {
    const state = stateFor(event.jobId)
    const at = now()
    if (state.timer === null && at - state.lastSentAt >= interval) {
      if (send('jobs:progress', event)) state.lastSentAt = at
      return
    }
    state.pending = event
    if (state.timer === null) {
      const delay = Math.max(0, state.lastSentAt + interval - at)
      state.timer = setTimer(() => {
        state.timer = null
        flushJob(event.jobId, state)
      }, delay)
    }
  }

  const onState = (snapshot: JobSnapshot): void => {
    const state = states.get(snapshot.id)
    if (state) flushJob(snapshot.id, state)
    send('jobs:state', snapshot)
    if (TERMINAL.has(snapshot.status)) states.delete(snapshot.id)
  }

  options.jobs.on('progress', onProgress)
  options.jobs.on('state', onState)

  return {
    flush() {
      for (const [jobId, state] of states) flushJob(jobId, state)
    },
    dispose() {
      options.jobs.off('progress', onProgress)
      options.jobs.off('state', onState)
      for (const state of states.values()) {
        if (state.timer !== null) clearTimer(state.timer)
      }
      states.clear()
    },
  }
}
