import { EventEmitter } from 'node:events'
import type { JobManager } from '@devmig/core'
import type { JobSnapshot, ProgressEvent } from '@devmig/model'
import { createLogger } from '@devmig/shared'
import { describe, expect, it } from 'vitest'
import { createJobBridge } from './job-bridge'

const logger = createLogger(() => {})

function progress(jobId: string, n: number): ProgressEvent {
  return {
    jobId,
    phase: 'SCANNING',
    message: `step ${n}`,
    level: 'info',
    at: new Date(n).toISOString(),
  }
}

function snapshot(jobId: string, status: JobSnapshot['status']): JobSnapshot {
  return {
    id: jobId,
    kind: 'scan',
    status,
    phase: status === 'completed' ? 'COMPLETE' : 'SCANNING',
    message: 'm',
    startedAt: new Date(0).toISOString(),
    recentEvents: [],
  }
}

interface Harness {
  jobs: EventEmitter
  sent: { channel: string; payload: unknown }[]
  clock: { now: number }
  timers: { fn: () => void; at: number; id: number; cleared: boolean }[]
  advance: (ms: number) => void
}

function harness(maxEventsPerSecond = 30): Harness & { dispose: () => void; flush: () => void } {
  const jobs = new EventEmitter()
  const sent: { channel: string; payload: unknown }[] = []
  const clock = { now: 1_000 }
  const timers: Harness['timers'] = []
  let nextId = 1
  const bridge = createJobBridge({
    jobs: jobs as unknown as Pick<JobManager, 'on' | 'off'>,
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    logger,
    maxEventsPerSecond,
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock.now + ms, id: nextId++, cleared: false }
      timers.push(timer)
      return timer.id
    },
    clearTimer: (handle) => {
      const timer = timers.find((t) => t.id === handle)
      if (timer) timer.cleared = true
    },
  })
  const advance = (ms: number): void => {
    clock.now += ms
    for (const timer of [...timers]) {
      if (!timer.cleared && timer.at <= clock.now) {
        timer.cleared = true
        timer.fn()
      }
    }
  }
  return {
    jobs,
    sent,
    clock,
    timers,
    advance,
    dispose: () => bridge.dispose(),
    flush: () => bridge.flush(),
  }
}

describe('job bridge', () => {
  it('forwards state events immediately and validates them', () => {
    const h = harness()
    h.jobs.emit('state', snapshot('job_1', 'running'))
    expect(h.sent).toMatchObject([{ channel: 'jobs:state', payload: { id: 'job_1' } }])
    h.jobs.emit('state', { id: 'job_2', bogus: true })
    expect(h.sent).toHaveLength(1)
    h.dispose()
  })

  it('throttles progress to the configured rate per job, always delivering the last event', () => {
    const h = harness(10) // 100 ms between events
    for (let i = 1; i <= 50; i += 1) h.jobs.emit('progress', progress('job_1', i))
    // Only the first event went out synchronously; the rest coalesce into one pending event.
    expect(h.sent.map((s) => (s.payload as ProgressEvent).message)).toEqual(['step 1'])
    h.advance(100)
    expect(h.sent.map((s) => (s.payload as ProgressEvent).message)).toEqual(['step 1', 'step 50'])
    // A second burst: still one per interval.
    for (let i = 51; i <= 60; i += 1) h.jobs.emit('progress', progress('job_1', i))
    h.advance(50)
    expect(h.sent).toHaveLength(2)
    h.advance(50)
    expect(h.sent.map((s) => (s.payload as ProgressEvent).message)).toEqual([
      'step 1',
      'step 50',
      'step 60',
    ])
    h.dispose()
  })

  it('never exceeds 30 events per second per job while a burst of 1000 events arrives over 1 s', () => {
    const h = harness()
    for (let i = 1; i <= 1000; i += 1) {
      h.jobs.emit('progress', progress('job_1', i))
      h.advance(1)
    }
    const perJob = h.sent.filter((s) => s.channel === 'jobs:progress')
    expect(perJob.length).toBeLessThanOrEqual(31)
    expect(perJob.length).toBeGreaterThanOrEqual(25)
    h.advance(100)
    expect((h.sent.at(-1)!.payload as ProgressEvent).message).toBe('step 1000')
    h.dispose()
  })

  it('throttles jobs independently', () => {
    const h = harness(10)
    h.jobs.emit('progress', progress('job_1', 1))
    h.jobs.emit('progress', progress('job_2', 1))
    expect(h.sent).toHaveLength(2)
    h.dispose()
  })

  it('flushes pending progress before a terminal state event and forgets the job', () => {
    const h = harness(10)
    h.jobs.emit('progress', progress('job_1', 1))
    h.jobs.emit('progress', progress('job_1', 2))
    h.jobs.emit('state', snapshot('job_1', 'completed'))
    expect(
      h.sent.map((s) => [
        s.channel,
        s.channel === 'jobs:progress' ? (s.payload as ProgressEvent).message : 'state',
      ]),
    ).toEqual([
      ['jobs:progress', 'step 1'],
      ['jobs:progress', 'step 2'],
      ['jobs:state', 'state'],
    ])
    expect(h.timers.every((t) => t.cleared)).toBe(true)
    h.dispose()
  })

  it('drops progress events that fail validation and keeps running', () => {
    const h = harness()
    h.jobs.emit('progress', { jobId: 'job_1', message: 'missing fields' })
    h.jobs.emit('progress', progress('job_1', 1))
    expect(h.sent).toHaveLength(1)
    h.dispose()
  })

  it('dispose detaches listeners and clears timers', () => {
    const h = harness(10)
    h.jobs.emit('progress', progress('job_1', 1))
    h.jobs.emit('progress', progress('job_1', 2))
    h.dispose()
    expect(h.timers.every((t) => t.cleared)).toBe(true)
    h.jobs.emit('progress', progress('job_1', 3))
    h.jobs.emit('state', snapshot('job_1', 'running'))
    expect(h.sent).toHaveLength(1)
  })
})
