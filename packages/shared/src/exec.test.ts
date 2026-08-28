import { describe, expect, it } from 'vitest'
import type { MigrationError } from './errors'
import { realExec } from './exec'

describe('realExec', () => {
  it('runs a binary with an argv array and reports a clean exit', async () => {
    const r = await realExec('/bin/echo', ['hi'], { timeoutMs: 5_000 })
    expect(r.stdout).toBe('hi\n')
    expect(r.exitCode).toBe(0)
    expect(r.failed).toBe(false)
    expect(r.timedOut).toBe(false)
  })

  it("stdin: 'ignore' lets a stdin-reading binary exit instead of waiting for input", async () => {
    const r = await realExec('/bin/cat', [], { stdin: 'ignore', timeoutMs: 5_000, reject: false })
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
  })

  it('marks a timed-out process as timedOut and failed without throwing when reject is false', async () => {
    const r = await realExec('/bin/sleep', ['5'], { timeoutMs: 200, reject: false })
    expect(r.timedOut).toBe(true)
    expect(r.failed).toBe(true)
    expect(r.exitCode).toBe(-1)
  })

  it('still feeds `input` when both input and stdin are given', async () => {
    const r = await realExec('/bin/cat', [], {
      input: 'from-input',
      stdin: 'ignore',
      timeoutMs: 5_000,
    })
    expect(r.stdout).toBe('from-input')
  })

  it('throws PATH_NOT_FOUND for a missing executable', async () => {
    await expect(
      realExec('/nonexistent/devmig-binary', [], { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
    } satisfies Partial<MigrationError>)
  })
})
