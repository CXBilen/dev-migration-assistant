import { ErrorCode, type SerializedError } from '@devmig/model'

/**
 * Normalizes anything thrown at the API boundary (IpcError from the preload bridge, a plain
 * Error, a rejected string) into a SerializedError the UI can render. Never includes secrets:
 * only the message/hint/details fields that already crossed the bridge are used.
 */
export function toSerializedError(err: unknown): SerializedError {
  if (err && typeof err === 'object') {
    const e = err as {
      code?: unknown
      message?: unknown
      hint?: unknown
      details?: unknown
      recoverable?: unknown
      name?: unknown
    }
    const code = ErrorCode.safeParse(e.code)
    const message = typeof e.message === 'string' && e.message ? e.message : 'Unexpected error.'
    return {
      code: code.success ? code.data : e.name === 'AbortError' ? 'CANCELLED' : 'UNKNOWN',
      message,
      hint: typeof e.hint === 'string' ? e.hint : undefined,
      details:
        e.details && typeof e.details === 'object' && !Array.isArray(e.details)
          ? (e.details as Record<string, unknown>)
          : undefined,
      recoverable: e.recoverable === true,
    }
  }
  return {
    code: 'UNKNOWN',
    message: typeof err === 'string' ? err : 'Unexpected error.',
    recoverable: false,
  }
}

export function isCancelled(err: SerializedError | null | undefined): boolean {
  return err?.code === 'CANCELLED'
}

/** Human title for an error code shown above the message. */
export function errorTitle(code: ErrorCode): string {
  switch (code) {
    case 'CANCELLED':
      return 'Cancelled'
    case 'ARCHIVE_AUTH_FAILED':
      return 'Could not unlock backup'
    case 'ARCHIVE_UNSUPPORTED_VERSION':
      return 'Unsupported backup version'
    case 'ARCHIVE_INVALID':
    case 'ARCHIVE_ENTRY_REJECTED':
    case 'ARCHIVE_LIMIT_EXCEEDED':
    case 'MANIFEST_INVALID':
    case 'INTEGRITY_MISMATCH':
      return 'Backup file rejected'
    case 'PERMISSION_DENIED':
    case 'RESTORE_PERMISSION_DENIED':
      return 'Permission denied'
    case 'DISK_FULL':
      return 'Not enough disk space'
    case 'GIT_NOT_INSTALLED':
      return 'Git is not installed'
    case 'CLAUDE_NOT_INSTALLED':
      return 'Claude Code is not installed'
    case 'CLAUDE_RUNNING':
      return 'Claude Code is running'
    case 'RESTORE_VERIFICATION_FAILED':
      return 'Verification failed'
    case 'PATH_NOT_FOUND':
      return 'Path not found'
    default:
      return 'Something went wrong'
  }
}
