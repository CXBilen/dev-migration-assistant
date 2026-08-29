/**
 * JobManager contract (THREAT_MODEL T12): one AbortController per job, cancelled-vs-failed
 * classification, the JOB_NOT_FOUND / JOB_ALREADY_FINISHED errors, the 200-event cap and redaction of
 * progress messages on the way to the logger. The end-to-end cancellation path is covered by
 * migration.integration.test.ts › … › Scenario C.
 */
import { describe, expect, it } from 'vitest'
import { MigrationError, createLogger, type LogRecord } from '@devmig/shared'
import { JobManager, type JobRunContext } from './job-manager'

const TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

function manager(): { jobs: JobManager; records: LogRecord[] } {
  const records: LogRecord[] = []
  return { jobs: new JobManager(createLogger((r) => records.push(r))), records }
}

/** Returns the MigrationError code a synchronous call throws (or 'no-throw'). */
function codeOf(fn: () => unknown): string {
  try {
    fn()
    return 'no-throw'
  } catch (err) {
    return (err as MigrationError).code
  }
}

/** A runner that never settles on its own and rejects with CANCELLED once its signal aborts. */
function cancellable(): {
  runner: (ctx: JobRunContext) => Promise<never>
  started: Promise<JobRunContext>
} {
  let announce!: (ctx: JobRunContext) => void
  const started = new Promise<JobRunContext>((resolve) => {
    announce = resolve
  })
  const runner = (ctx: JobRunContext): Promise<never> => {
    announce(ctx)
    return new Promise<never>((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () =>
        reject(new MigrationError('CANCELLED', 'The operation was cancelled.')),
      )
    })
  }
  return { runner, started }
}

describe('JobManager', () => {
  it('gives each job its own AbortController and cancels only the requested job', async () => {
    const { jobs } = manager()
    const a = cancellable()
    const b = cancellable()
    const first = jobs.start('backup', a.runner)
    const second = jobs.start('restore', b.runner)
    const ctxA = await a.started
    const ctxB = await b.started
    expect(first.id).not.toBe(second.id)

    jobs.cancel(first.id)
    expect(ctxA.signal.aborted).toBe(true)
    expect(ctxB.signal.aborted).toBe(false)
    expect((await jobs.wait(first.id)).status).toBe('cancelled')
    expect(jobs.status(second.id)).toBe('running')
    expect(
      jobs
        .list()
        .map((j) => j.id)
        .sort(),
    ).toEqual([first.id, second.id].sort())

    jobs.cancel(second.id)
    await jobs.wait(second.id)
  })

  it('classifies an aborted run and a CANCELLED rejection as cancelled with a warn event', async () => {
    const { jobs } = manager()
    const a = cancellable()
    const aborted = jobs.start('backup', a.runner)
    await a.started
    jobs.cancel(aborted.id)
    const cancelled = await jobs.wait(aborted.id)
    expect(cancelled).toMatchObject({ status: 'cancelled', phase: 'CANCELLED' })
    expect(cancelled.recentEvents.at(-1)).toMatchObject({ level: 'warn', phase: 'CANCELLED' })

    // Same classification without an abort: the runner itself reports CANCELLED (job-manager.ts:113).
    const selfCancelled = jobs.start('restore', () =>
      Promise.reject(new MigrationError('CANCELLED', 'user quit')),
    )
    const snapshot = await jobs.wait(selfCancelled.id)
    expect(snapshot).toMatchObject({ status: 'cancelled', phase: 'CANCELLED' })
    expect(snapshot.error?.code).toBe('CANCELLED')

    // Anything else is a failure, reported at error level.
    const failed = jobs.start('scan', () =>
      Promise.reject(new MigrationError('PROVIDER_FAILED', 'boom')),
    )
    const failedSnapshot = await jobs.wait(failed.id)
    expect(failedSnapshot).toMatchObject({ status: 'failed', phase: 'FAILED' })
    expect(failedSnapshot.recentEvents.at(-1)?.level).toBe('error')
  })

  it('refuses to cancel an unknown or already finished job', async () => {
    const { jobs } = manager()
    expect(codeOf(() => jobs.cancel('job_missing'))).toBe('JOB_NOT_FOUND')
    expect(codeOf(() => jobs.get('job_missing'))).toBe('JOB_NOT_FOUND')
    await expect(jobs.wait('job_missing')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })

    const done = jobs.start('scan', () => Promise.resolve('ok'))
    await jobs.wait(done.id)
    expect(codeOf(() => jobs.cancel(done.id))).toBe('JOB_ALREADY_FINISHED')
  })

  it('rethrows the serialized code and hint from result() and caps recentEvents at 200', async () => {
    const { jobs } = manager()
    const failing = jobs.start('backup', () =>
      Promise.reject(
        new MigrationError('DISK_FULL', 'no space left on device', {
          hint: 'Free up disk space and try again.',
        }),
      ),
    )
    await expect(jobs.result(failing.id)).rejects.toMatchObject({
      code: 'DISK_FULL',
      hint: 'Free up disk space and try again.',
    })

    const chatty = jobs.start('scan', (ctx) => {
      for (let i = 0; i < 250; i += 1) ctx.progress(`step ${i}`)
      return Promise.resolve('done')
    })
    expect(await jobs.result<string>(chatty.id)).toBe('done')
    const snapshot = await jobs.wait(chatty.id)
    // 250 progress events + the final 'Completed' event, trimmed to MAX_RECENT_EVENTS from the front.
    expect(snapshot.recentEvents).toHaveLength(200)
    expect(snapshot.recentEvents[0]?.message).toBe('step 51')
    expect(snapshot.recentEvents.at(-1)?.message).toBe('Completed')
  })

  it('redacts secret-looking progress messages before they reach the logger', async () => {
    const { jobs, records } = manager()
    const job = jobs.start('scan', (ctx) => {
      ctx.progress(`probing with token=${TOKEN}`)
      return Promise.resolve('ok')
    })
    await jobs.wait(job.id)
    expect(JSON.stringify(records)).not.toContain('abcdefghijklmnop')
    expect(records.some((r) => r.msg.includes('[REDACTED]'))).toBe(true)
    // Every record carries the job context the manager attaches (job-manager.ts:54).
    expect(records.every((r) => r.ctx.jobId === job.id && r.ctx.jobKind === 'scan')).toBe(true)
  })
})
