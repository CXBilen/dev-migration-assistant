import type { ErrorCode, SerializedError } from '@devmig/model'
import { redactSecrets } from './redact'

export interface MigrationErrorOptions {
  hint?: string
  details?: Record<string, unknown>
  recoverable?: boolean
  cause?: unknown
}

/** The only error type that should cross module boundaries. Always carries a stable code. */
export class MigrationError extends Error {
  readonly code: ErrorCode
  readonly hint: string | undefined
  readonly details: Record<string, unknown> | undefined
  readonly recoverable: boolean

  constructor(code: ErrorCode, message: string, options: MigrationErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'MigrationError'
    this.code = code
    this.hint = options.hint
    this.details = options.details
    this.recoverable = options.recoverable ?? false
  }

  toJSON(): SerializedError {
    return serializeError(this)
  }
}

export function isMigrationError(err: unknown): err is MigrationError {
  return (
    err instanceof MigrationError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: string }).name === 'MigrationError')
  )
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
}

/** Converts any thrown value into a redacted, IPC-safe SerializedError. */
export function serializeError(err: unknown): SerializedError {
  if (isAbortError(err)) {
    return { code: 'CANCELLED', message: 'The operation was cancelled.', recoverable: true }
  }
  if (isMigrationError(err)) {
    const e = err
    const causeMsg =
      e.cause instanceof Error ? e.cause.message : typeof e.cause === 'string' ? e.cause : undefined
    return {
      code: e.code,
      message: redactSecrets(e.message),
      hint: e.hint,
      details: e.details
        ? (JSON.parse(redactSecrets(JSON.stringify(e.details))) as Record<string, unknown>)
        : undefined,
      recoverable: e.recoverable,
      cause: causeMsg ? redactSecrets(causeMsg) : undefined,
    }
  }
  if (err instanceof Error) {
    const nodeCode = (err as NodeJS.ErrnoException).code
    const code: ErrorCode =
      nodeCode === 'EACCES' || nodeCode === 'EPERM'
        ? 'PERMISSION_DENIED'
        : nodeCode === 'ENOENT'
          ? 'PATH_NOT_FOUND'
          : nodeCode === 'ENOSPC'
            ? 'DISK_FULL'
            : nodeCode === 'ENOTDIR'
              ? 'NOT_A_DIRECTORY'
              : 'UNKNOWN'
    return {
      code,
      message: redactSecrets(err.message),
      recoverable: false,
      details: nodeCode ? { errno: nodeCode } : undefined,
    }
  }
  return { code: 'UNKNOWN', message: redactSecrets(String(err)), recoverable: false }
}

/** Throws a CANCELLED MigrationError when the signal is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MigrationError('CANCELLED', 'The operation was cancelled.', { recoverable: true })
  }
}
