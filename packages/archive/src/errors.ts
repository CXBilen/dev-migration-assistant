import type { ErrorCode } from '@devmig/model'
import { MigrationError, isAbortError, isMigrationError } from '@devmig/shared'

export function invalid(message: string, details?: Record<string, unknown>): MigrationError {
  return new MigrationError('ARCHIVE_INVALID', message, { details })
}

export function integrity(message: string, details?: Record<string, unknown>): MigrationError {
  return new MigrationError('INTEGRITY_MISMATCH', message, {
    hint: 'The backup file is damaged or was modified. Nothing was restored from it.',
    details,
  })
}

export function cancelled(): MigrationError {
  return new MigrationError('CANCELLED', 'The operation was cancelled.', { recoverable: true })
}

export function limitExceeded(message: string, details?: Record<string, unknown>): MigrationError {
  return new MigrationError('ARCHIVE_LIMIT_EXCEEDED', message, { details })
}

export function entryRejected(message: string, details?: Record<string, unknown>): MigrationError {
  return new MigrationError('ARCHIVE_ENTRY_REJECTED', message, { details })
}

interface ErrorLike {
  name?: unknown
  code?: unknown
  tarCode?: unknown
  message?: unknown
}

function asErrorLike(err: unknown): ErrorLike {
  return typeof err === 'object' && err !== null ? err : {}
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const m = asErrorLike(err).message
  return typeof m === 'string' ? m : String(err)
}

/**
 * Converts any failure raised inside a stream pipeline into a MigrationError with a stable code.
 * Abort → CANCELLED; tar parser errors → ARCHIVE_INVALID; fs errors → their usual codes.
 */
export function toMigrationError(err: unknown, fallback: ErrorCode = 'IO_ERROR'): MigrationError {
  if (isMigrationError(err)) return err
  const like = asErrorLike(err)
  if (isAbortError(err) || like.code === 'ABORT_ERR') return cancelled()
  if (typeof like.tarCode === 'string') {
    return new MigrationError('ARCHIVE_INVALID', `Malformed tar payload: ${errorMessage(err)}`, {
      details: { tarCode: like.tarCode },
      cause: err,
    })
  }
  const code = typeof like.code === 'string' ? like.code : undefined
  const mapped: ErrorCode | undefined =
    code === 'ENOSPC'
      ? 'DISK_FULL'
      : code === 'EACCES' || code === 'EPERM'
        ? 'PERMISSION_DENIED'
        : code === 'ENOENT'
          ? 'PATH_NOT_FOUND'
          : code === 'ENOTDIR'
            ? 'NOT_A_DIRECTORY'
            : code === 'EISDIR' || code === 'EEXIST' || code === 'EMFILE' || code === 'EIO'
              ? 'IO_ERROR'
              : undefined
  return new MigrationError(mapped ?? fallback, errorMessage(err), {
    details: code ? { errno: code } : undefined,
    cause: err,
  })
}
