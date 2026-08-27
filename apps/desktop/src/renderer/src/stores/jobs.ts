/**
 * Tracks jobs the UI cares about. Subscriptions go through the API bridge; each tracked job
 * keeps its latest snapshot and a bounded event list so screens can render checklists and logs.
 */
import type { JobSnapshot, ProgressEvent } from '@devmig/model'
import { create } from 'zustand'
import { getApi } from '../api'
import { toSerializedError } from '../lib/errors'
import { log } from '../lib/log'

const MAX_EVENTS = 400

export interface TrackedJob {
  id: string
  snapshot: JobSnapshot | null
  events: ProgressEvent[]
  /** Set when the job could not be looked up at all (e.g. after an app restart). */
  lookupError: string | null
}

interface JobsState {
  jobs: Record<string, TrackedJob>
  /** Start tracking a job. Returns a function that stops tracking. Reference-counted. */
  track: (jobId: string) => () => void
  cancel: (jobId: string) => Promise<void>
  forget: (jobId: string) => void
}

const subscriptions = new Map<string, { refs: number; unsubscribe: () => void }>()

function mergeEvents(existing: ProgressEvent[], incoming: ProgressEvent[]): ProgressEvent[] {
  if (incoming.length === 0) return existing
  const seen = new Set(existing.map((e) => `${e.at}|${e.phase}|${e.message}`))
  const merged = [...existing]
  for (const e of incoming) {
    const key = `${e.at}|${e.phase}|${e.message}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(e)
  }
  return merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged
}

export const useJobsStore = create<JobsState>((set, get) => ({
  jobs: {},
  track: (jobId) => {
    const existing = subscriptions.get(jobId)
    if (existing) {
      existing.refs += 1
    } else {
      const api = getApi()
      if (!get().jobs[jobId])
        set((s) => ({
          jobs: {
            ...s.jobs,
            [jobId]: { id: jobId, snapshot: null, events: [], lookupError: null },
          },
        }))
      const offProgress = api.jobs.onProgress(jobId, (event) => {
        set((s) => {
          const job = s.jobs[jobId] ?? { id: jobId, snapshot: null, events: [], lookupError: null }
          const snapshot = job.snapshot
            ? {
                ...job.snapshot,
                phase: event.phase,
                message: event.message,
                progress:
                  event.progress ??
                  (event.phase === job.snapshot.phase ? job.snapshot.progress : undefined),
              }
            : null
          return {
            jobs: {
              ...s.jobs,
              [jobId]: { ...job, snapshot, events: mergeEvents(job.events, [event]) },
            },
          }
        })
      })
      const offState = api.jobs.onState(jobId, (snapshot) => {
        set((s) => {
          const job = s.jobs[jobId] ?? { id: jobId, snapshot: null, events: [], lookupError: null }
          return {
            jobs: {
              ...s.jobs,
              [jobId]: { ...job, snapshot, events: mergeEvents(job.events, snapshot.recentEvents) },
            },
          }
        })
      })
      subscriptions.set(jobId, {
        refs: 1,
        unsubscribe: () => {
          offProgress()
          offState()
        },
      })
      api.jobs
        .get(jobId)
        .then((snapshot) => {
          set((s) => {
            const job = s.jobs[jobId] ?? {
              id: jobId,
              snapshot: null,
              events: [],
              lookupError: null,
            }
            // A state event may already have delivered a newer snapshot; keep the most advanced one.
            const newer =
              job.snapshot && job.snapshot.status !== 'running' && job.snapshot.status !== 'queued'
                ? job.snapshot
                : snapshot
            return {
              jobs: {
                ...s.jobs,
                [jobId]: {
                  ...job,
                  snapshot: newer,
                  events: mergeEvents(job.events, snapshot.recentEvents),
                },
              },
            }
          })
        })
        .catch((err: unknown) => {
          const serialized = toSerializedError(err)
          log.warn('Could not look up job', { jobId, code: serialized.code })
          set((s) => {
            const job = s.jobs[jobId] ?? {
              id: jobId,
              snapshot: null,
              events: [],
              lookupError: null,
            }
            return { jobs: { ...s.jobs, [jobId]: { ...job, lookupError: serialized.message } } }
          })
        })
    }
    return () => {
      const sub = subscriptions.get(jobId)
      if (!sub) return
      sub.refs -= 1
      if (sub.refs <= 0) {
        sub.unsubscribe()
        subscriptions.delete(jobId)
      }
    }
  },
  cancel: async (jobId) => {
    try {
      await getApi().jobs.cancel(jobId)
    } catch (err) {
      const serialized = toSerializedError(err)
      // JOB_ALREADY_FINISHED is not an error from the user's point of view.
      if (serialized.code !== 'JOB_ALREADY_FINISHED') throw err
    }
  },
  forget: (jobId) => {
    const sub = subscriptions.get(jobId)
    if (sub) {
      sub.unsubscribe()
      subscriptions.delete(jobId)
    }
    set((s) => {
      const rest = { ...s.jobs }
      delete rest[jobId]
      return { jobs: rest }
    })
  },
}))
