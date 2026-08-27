import { z } from 'zod'

/**
 * Stable, user-facing error codes. Every failure surfaced to the UI carries one of these.
 * Keep the list append-only; codes are part of the diagnostics contract.
 */
export const ErrorCode = z.enum([
  'UNKNOWN',
  'CANCELLED',
  'INVALID_INPUT',
  'NOT_A_DIRECTORY',
  'PATH_NOT_FOUND',
  'PATH_OUTSIDE_ALLOWED_ROOT',
  'PERMISSION_DENIED',
  'ARCHIVE_INVALID',
  'ARCHIVE_AUTH_FAILED',
  'ARCHIVE_UNSUPPORTED_VERSION',
  'ARCHIVE_LIMIT_EXCEEDED',
  'ARCHIVE_ENTRY_REJECTED',
  'INTEGRITY_MISMATCH',
  'MANIFEST_INVALID',
  'PROJECT_PATH_COLLISION',
  'PROJECT_NOT_FOUND',
  'CLAUDE_NOT_INSTALLED',
  'CLAUDE_DATA_DIR_NOT_FOUND',
  'CLAUDE_PROJECT_AMBIGUOUS',
  'CLAUDE_RUNNING',
  'GIT_NOT_INSTALLED',
  'GIT_COMMAND_FAILED',
  'GIT_BUNDLE_FAILED',
  'GIT_APPLY_FAILED',
  'GIT_INVALID_REF',
  'WORKTREE_CONFLICT',
  'RESTORE_PLAN_REJECTED',
  'RESTORE_PERMISSION_DENIED',
  'RESTORE_DESTINATION_EXISTS',
  'RESTORE_VERIFICATION_FAILED',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_FAILED',
  'JOB_NOT_FOUND',
  'JOB_ALREADY_FINISHED',
  'DISK_FULL',
  'IO_ERROR',
])
export type ErrorCode = z.infer<typeof ErrorCode>

/** Serialized error safe to cross the IPC boundary (never contains secrets). */
export const SerializedError = z.object({
  code: ErrorCode,
  message: z.string(),
  /** Actionable hint for the user, e.g. "No source files were modified." */
  hint: z.string().optional(),
  /** Non-sensitive structured details (paths are allowed; secrets are not). */
  details: z.record(z.string(), z.unknown()).optional(),
  recoverable: z.boolean().default(false),
  cause: z.string().optional(),
})
export type SerializedError = z.infer<typeof SerializedError>
