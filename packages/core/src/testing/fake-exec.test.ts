import { describe, expect, it } from 'vitest'
import { isMigrationError } from '@devmig/shared'
import { createFakeExec } from './fake-exec'

describe('createFakeExec (core)', () => {
  it('fills the ExecResult defaults: exit 0, not failed, not timed out', async () => {
    const exec = createFakeExec(() => ({ stdout: 'ok\n' }))
    const result = await exec('claude', ['--version'], { cwd: '/x' })
    expect(result).toEqual({
      stdout: 'ok\n',
      stderr: '',
      stdoutBuffer: Buffer.from('ok\n'),
      exitCode: 0,
      failed: false,
      timedOut: false,
      command: 'claude --version',
    })
    expect(exec.calls).toEqual([{ file: 'claude', args: ['--version'], options: { cwd: '/x' } }])
  })

  it('scripts a timeout: timedOut is reported and the reply counts as failed', async () => {
    const exec = createFakeExec(() => ({ stderr: 'timed out', timedOut: true }))
    const result = await exec('claude', ['auth', 'status'], { reject: false })
    expect(result.timedOut).toBe(true)
    expect(result.failed).toBe(true)
    await expect(exec('claude', ['auth', 'status'])).rejects.toSatisfy(
      (e: unknown) => isMigrationError(e) && e.code === 'GIT_COMMAND_FAILED',
    )
  })

  it('throws PATH_NOT_FOUND when the handler has no reply for the binary', async () => {
    const exec = createFakeExec(() => undefined)
    await expect(exec('claude', ['--version'])).rejects.toSatisfy(
      (e: unknown) => isMigrationError(e) && e.code === 'PATH_NOT_FOUND',
    )
  })
})
