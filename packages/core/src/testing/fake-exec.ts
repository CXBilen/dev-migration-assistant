/**
 * Test helper: an `Exec` implementation driven by a handler table. Never spawns a process.
 * Lives in src/testing so provider packages and the desktop app can reuse it in their own tests.
 */
import { MigrationError, type Exec, type ExecOptions, type ExecResult } from '@devmig/shared'

export interface FakeExecReply {
  stdout?: string
  stderr?: string
  exitCode?: number
}

export type FakeExecHandler = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => FakeExecReply | Promise<FakeExecReply> | undefined

export interface FakeExec extends Exec {
  calls: { file: string; args: string[]; options: ExecOptions }[]
}

/** Errors thrown for "binary missing" look like the real thing (PATH_NOT_FOUND). */
export function createFakeExec(handler: FakeExecHandler): FakeExec {
  const calls: FakeExec['calls'] = []
  const exec = (async (file, args, options = {}) => {
    calls.push({ file, args: [...args], options })
    if (options.signal?.aborted) {
      throw new MigrationError('CANCELLED', 'The operation was cancelled.', { recoverable: true })
    }
    const reply = await handler(file, args, options)
    if (reply === undefined) {
      throw new MigrationError('PATH_NOT_FOUND', `Executable not found: ${file}`, {
        details: { file },
      })
    }
    const stdout = reply.stdout ?? ''
    const stderr = reply.stderr ?? ''
    const exitCode = reply.exitCode ?? 0
    const failed = exitCode !== 0
    const result: ExecResult = {
      stdout,
      stderr,
      stdoutBuffer: Buffer.from(stdout, 'utf8'),
      exitCode,
      failed,
      command: [file, ...args].join(' '),
    }
    if (failed && options.reject !== false) {
      throw new MigrationError(
        'GIT_COMMAND_FAILED',
        `Command failed (${exitCode}): ${file} ${args.join(' ')}\n${stderr.trim()}`,
        { details: { file, args: [...args], exitCode, stderr } },
      )
    }
    return result
  }) as FakeExec
  exec.calls = calls
  return exec
}
