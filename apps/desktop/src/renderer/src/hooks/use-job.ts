import type { JobSnapshot, ProgressEvent } from '@devmig/model'
import { useEffect, useMemo } from 'react'
import { TERMINAL_PHASES } from '../lib/phases'
import { useJobsStore, type TrackedJob } from '../stores/jobs'

const EMPTY: TrackedJob = { id: '', snapshot: null, events: [], lookupError: null }

export interface JobView {
  job: TrackedJob
  snapshot: JobSnapshot | null
  events: ProgressEvent[]
  status: JobSnapshot['status'] | undefined
  /** Last non-terminal phase the job reported (so failures still show where they happened). */
  lastPhase: string | undefined
  isRunning: boolean
  isDone: boolean
}

/** Subscribes to a job for the lifetime of the component and returns its live view. */
export function useJob(jobId: string | null | undefined): JobView {
  const track = useJobsStore((s) => s.track)
  useEffect(() => {
    if (!jobId) return
    return track(jobId)
  }, [jobId, track])
  const job = useJobsStore((s) => (jobId ? s.jobs[jobId] : undefined)) ?? EMPTY
  return useMemo(() => {
    const snapshot = job.snapshot
    const status = snapshot?.status
    let lastPhase: string | undefined
    for (let i = job.events.length - 1; i >= 0; i -= 1) {
      const phase = job.events[i]?.phase
      if (phase && !TERMINAL_PHASES.has(phase)) {
        lastPhase = phase
        break
      }
    }
    if (!lastPhase && snapshot && !TERMINAL_PHASES.has(snapshot.phase)) lastPhase = snapshot.phase
    return {
      job,
      snapshot,
      events: job.events,
      status,
      lastPhase,
      isRunning:
        status === 'running' || status === 'queued' || (status === undefined && !job.lookupError),
      isDone: status === 'completed' || status === 'failed' || status === 'cancelled',
    }
  }, [job])
}

export interface ChecklistItem {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'warn' | 'failed' | 'skipped'
  projectId: string | undefined
  providerId: string | undefined
}

/** Folds progress events with `item` markers into an ordered list (first-seen order, latest status). */
export function checklistFromEvents(events: ProgressEvent[]): ChecklistItem[] {
  const map = new Map<string, ChecklistItem>()
  for (const e of events) {
    if (!e.item) continue
    const key = e.item.id
    const existing = map.get(key)
    if (existing) {
      existing.status = e.item.status
      existing.label = e.item.label
    } else {
      map.set(key, {
        id: key,
        label: e.item.label,
        status: e.item.status,
        projectId: e.projectId,
        providerId: e.providerId,
      })
    }
  }
  return [...map.values()]
}
