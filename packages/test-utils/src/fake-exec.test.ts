import { describe, expect, it } from 'vitest'
import { isMigrationError } from '@devmig/shared'
import { createFakeExec, matchCommand } from './fake-exec'

describe('createFakeExec', () => {
  it('returns scripted results, records every call and fills ExecResult defaults', async () => {
    const fake = createFakeExec([
      { match: matchCommand('git', 'rev-parse'), result: { stdout: 'abc\n' } },
      {
        match: (file, args) => file === 'git' && args[0] === 'status',
        result: (_file, args) => ({ stdout: `status ${args.length}` }),
      },
    ])
    const r1 = await fake.exec('git', ['rev-parse', 'HEAD'], { cwd: '/x' })
    expect(r1).toEqual({
      stdout: 'abc\n',
      stderr: '',
      stdoutBuffer: Buffer.from('abc\n'),
      exitCode: 0,
      failed: false,
      command: 'git rev-parse HEAD',
    })
    const r2 = await fake.exec('git', ['status', '--porcelain=v2'])
    expect(r2.stdout).toBe('status 2')
    expect(fake.calls).toEqual([
      { file: 'git', args: ['rev-parse', 'HEAD'], options: { cwd: '/x' } },
      { file: 'git', args: ['status', '--porcelain=v2'], options: undefined },
    ])
    expect(fake.callsMatching(matchCommand('git', 'status'))).toHaveLength(1)
    fake.reset()
    expect(fake.calls).toEqual([])
  })

  it('throws GIT_COMMAND_FAILED on non-zero exit unless reject is false', async () => {
    const fake = createFakeExec([
      { match: matchCommand('git'), result: { exitCode: 128, stderr: 'fatal: nope' } },
    ])
    await expect(fake.exec('git', ['x'])).rejects.toSatisfy(
      (e: unknown) => isMigrationError(e) && e.code === 'GIT_COMMAND_FAILED',
    )
    const soft = await fake.exec('git', ['x'], { reject: false })
    expect(soft).toMatchObject({ exitCode: 128, failed: true, stderr: 'fatal: nope' })
  })

  it('throws on unmatched commands by default, or fails softly with onUnmatched: "fail"', async () => {
    const strict = createFakeExec([])
    await expect(strict.exec('claude', ['--version'])).rejects.toSatisfy(
      (e: unknown) => isMigrationError(e) && e.message.includes('no handler matched'),
    )
    const lenient = createFakeExec([], { onUnmatched: 'fail' })
    const r = await lenient.exec('claude', ['--version'], { reject: false })
    expect(r).toMatchObject({ exitCode: 127, failed: true })
  })

  it('honours an aborted signal', async () => {
    const fake = createFakeExec([{ match: () => true, result: {} }])
    const controller = new AbortController()
    controller.abort()
    await expect(fake.exec('git', ['x'], { signal: controller.signal })).rejects.toSatisfy(
      (e: unknown) => isMigrationError(e) && e.code === 'CANCELLED',
    )
  })

  it('materializes stdoutBuffer for binary handlers', async () => {
    const buf = Buffer.from([0, 1, 2])
    const fake = createFakeExec([{ match: () => true, result: { stdoutBuffer: buf } }])
    const r = await fake.exec('git', ['diff'], { binary: true })
    expect(r.stdoutBuffer.equals(buf)).toBe(true)
  })
})
