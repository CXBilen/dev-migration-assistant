/**
 * Validation of paths the renderer sends to the main process.
 *
 * - Read paths (scan targets, backup files to open) must be absolute and free of NUL bytes.
 * - Write destinations (restore mappings) must additionally live inside the user's home, /Users or
 *   /Volumes — or have been picked through a native dialog during this session.
 */
import path from 'node:path'
import { MigrationError, canonicalizePath, expandHome, isPathWithin } from '@devmig/shared'
import type { ApprovedPaths } from './approved-paths'

export const ALLOWED_DESTINATION_ROOTS = ['/Users', '/Volumes'] as const

export interface DestinationOptions {
  homeDir: string
  approved?: ApprovedPaths
  /** Extra allowed roots (E2E fixtures live under the OS temp dir). */
  extraRoots?: readonly string[]
}

/** Canonicalizes a path the renderer sent for READ access. Throws INVALID_INPUT for anything unusable. */
export function validateReadPath(raw: string, homeDir: string, label = 'Path'): string {
  if (typeof raw !== 'string')
    throw new MigrationError('INVALID_INPUT', `${label} must be a string.`)
  const trimmed = raw.trim()
  if (trimmed === '') throw new MigrationError('INVALID_INPUT', `${label} must not be empty.`)
  if (trimmed.includes('\0'))
    throw new MigrationError('INVALID_INPUT', `${label} contains an invalid character.`)
  if (trimmed.length > 4096) throw new MigrationError('INVALID_INPUT', `${label} is too long.`)
  const expanded = expandHome(trimmed, homeDir)
  if (!path.isAbsolute(expanded)) {
    throw new MigrationError('INVALID_INPUT', `${label} must be absolute.`, {
      details: { path: trimmed },
    })
  }
  if (expanded.split(path.sep).includes('..')) {
    throw new MigrationError('INVALID_INPUT', `${label} must not contain ".." segments.`, {
      details: { path: trimmed },
    })
  }
  return canonicalizePath(expanded, homeDir)
}

/**
 * Canonicalizes a WRITE destination typed or picked by the user. Returns the canonical path or throws
 * INVALID_INPUT / PATH_OUTSIDE_ALLOWED_ROOT.
 */
export function validateDestinationPath(
  raw: string,
  options: DestinationOptions,
  label = 'Destination',
): string {
  const canonical = validateReadPath(raw, options.homeDir, label)
  if (options.approved?.has(canonical)) return canonical
  const home = canonicalizePath(options.homeDir, options.homeDir)
  const roots = [home, ...ALLOWED_DESTINATION_ROOTS, ...(options.extraRoots ?? [])]
  for (const root of roots) {
    if (canonical === root) {
      throw new MigrationError(
        'PATH_OUTSIDE_ALLOWED_ROOT',
        `${label} may not be ${root} itself. Choose a folder inside it.`,
        { details: { path: canonical } },
      )
    }
  }
  const inside = roots.some((root) => isPathWithin(root, canonical))
  if (!inside) {
    throw new MigrationError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      `${label} must be inside your home folder, /Users or /Volumes.`,
      {
        details: { path: canonical },
        hint: 'Use the Choose… button to pick a folder, or type a path inside your home folder.',
      },
    )
  }
  return canonical
}
