import { execa, type Options as ExecaOptions } from 'execa'
import { MigrationError } from './errors'

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  signal?: AbortSignal
  /** Buffer stdout as Buffer instead of string (binary diffs). */
  binary?: boolean
  /** Do not throw on non-zero exit. */
  reject?: boolean
  input?: string | Buffer
  maxBuffer?: number
}

export interface ExecResult {
  stdout: string
  stderr: string
  stdoutBuffer: Buffer
  exitCode: number
  failed: boolean
  command: string
}

/**
 * Executes a binary with an ARGUMENT ARRAY. There is deliberately no way to pass a shell string.
 * Every provider must receive an `Exec` through its context so tests can stub it.
 */
export type Exec = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>

export const realExec: Exec = async (file, args, options = {}) => {
  const execaOptions: ExecaOptions = {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs ?? 120_000,
    cancelSignal: options.signal,
    reject: false,
    shell: false,
    windowsHide: true,
    encoding: options.binary ? 'buffer' : 'utf8',
    input: options.input,
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    stripFinalNewline: false,
  }
  const result = await execa(file, [...args], execaOptions)
  const stdoutBuffer = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(String(result.stdout ?? ''), 'utf8')
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout.toString('utf8')
    : String(result.stdout ?? '')
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString('utf8')
    : String(result.stderr ?? '')
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1
  const failed = result.failed || exitCode !== 0
  const command = [file, ...args].join(' ')
  if (options.signal?.aborted) {
    throw new MigrationError('CANCELLED', 'The operation was cancelled.', { recoverable: true })
  }
  if (failed && options.reject !== false) {
    const code = (result as { code?: string }).code
    if (code === 'ENOENT') {
      throw new MigrationError('PATH_NOT_FOUND', `Executable not found: ${file}`, {
        details: { file },
      })
    }
    throw new MigrationError(
      'GIT_COMMAND_FAILED',
      `Command failed (${exitCode}): ${file} ${args.join(' ')}\n${stderr.trim()}`,
      {
        details: { file, args: [...args], exitCode, stderr: stderr.slice(0, 4000) },
      },
    )
  }
  return { stdout, stderr, stdoutBuffer, exitCode, failed, command }
}
