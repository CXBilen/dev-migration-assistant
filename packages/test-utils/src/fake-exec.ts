import type { Exec, ExecOptions, ExecResult } from '@devmig/shared'
import { MigrationError } from '@devmig/shared'

export interface FakeExecCall {
  file: string
  args: string[]
  options: ExecOptions | undefined
}

export type FakeExecResultFactory = (
  file: string,
  args: readonly string[],
  options: ExecOptions | undefined,
) => Partial<ExecResult> | Promise<Partial<ExecResult>>

export interface FakeExecHandler {
  match: (file: string, args: readonly string[]) => boolean
  /** Static partial result (defaults: exit 0, empty output) or a factory computing one per call. */
  result: Partial<ExecResult> | FakeExecResultFactory
}

export interface FakeExecOptions {
  /**
   * What to do when no handler matches: throw a MigrationError (default, surfaces test bugs early)
   * or return a failed result with exit code 127.
   */
  onUnmatched?: 'throw' | 'fail'
}

export interface FakeExec {
  /** Pass this where an `Exec` is expected. */
  exec: Exec
  /** Every call in order, with the exact argv the code under test produced. */
  calls: FakeExecCall[]
  /** Calls whose file/args matched the given predicate. */
  callsMatching: (match: (file: string, args: readonly string[]) => boolean) => FakeExecCall[]
  /** Forgets recorded calls (handlers stay). */
  reset: () => void
}

/** Handler matcher for `file` with the given leading arguments, e.g. matchCommand('git', 'status'). */
export function matchCommand(
  file: string,
  ...argPrefix: string[]
): (file: string, args: readonly string[]) => boolean {
  return (f, args) => f === file && argPrefix.every((a, i) => args[i] === a)
}

function materialize(
  partial: Partial<ExecResult>,
  file: string,
  args: readonly string[],
): ExecResult {
  const stdout =
    partial.stdout ??
    (partial.stdoutBuffer !== undefined ? partial.stdoutBuffer.toString('utf8') : '')
  const stdoutBuffer = partial.stdoutBuffer ?? Buffer.from(stdout, 'utf8')
  const exitCode = partial.exitCode ?? 0
  return {
    stdout,
    stderr: partial.stderr ?? '',
    stdoutBuffer,
    exitCode,
    failed: partial.failed ?? exitCode !== 0,
    timedOut: partial.timedOut ?? false,
    command: partial.command ?? [file, ...args].join(' '),
  }
}

/**
 * Builds a scripted `Exec` for unit tests. Handlers are consulted in order; the first match wins.
 * Mirrors realExec's contract: non-zero exit throws GIT_COMMAND_FAILED unless `reject: false`,
 * and an aborted signal throws CANCELLED.
 */
export function createFakeExec(
  handlers: readonly FakeExecHandler[],
  opts: FakeExecOptions = {},
): FakeExec {
  const calls: FakeExecCall[] = []
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args: [...args], options })
    if (options?.signal?.aborted) {
      throw new MigrationError('CANCELLED', 'The operation was cancelled.', { recoverable: true })
    }
    const handler = handlers.find((h) => h.match(file, args))
    let result: ExecResult
    if (!handler) {
      if ((opts.onUnmatched ?? 'throw') === 'throw') {
        throw new MigrationError(
          'GIT_COMMAND_FAILED',
          `fakeExec: no handler matched: ${[file, ...args].join(' ')}`,
          { details: { file, args: [...args] } },
        )
      }
      result = materialize(
        { exitCode: 127, stderr: `fakeExec: no handler for ${file}`, failed: true },
        file,
        args,
      )
    } else {
      const partial =
        typeof handler.result === 'function'
          ? await handler.result(file, args, options)
          : handler.result
      result = materialize(partial, file, args)
    }
    if (result.failed && options?.reject !== false) {
      throw new MigrationError(
        'GIT_COMMAND_FAILED',
        `Command failed (${result.exitCode}): ${file} ${args.join(' ')}\n${result.stderr.trim()}`,
        { details: { file, args: [...args], exitCode: result.exitCode, stderr: result.stderr } },
      )
    }
    return result
  }
  return {
    exec,
    calls,
    callsMatching: (match) => calls.filter((c) => match(c.file, c.args)),
    reset: () => {
      calls.length = 0
    },
  }
}
