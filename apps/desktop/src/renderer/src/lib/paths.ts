/**
 * Pure path helpers for display. The renderer never touches the filesystem; these only
 * manipulate strings the main process handed us.
 */

/** Abbreviates the home directory prefix to `~`. Without a known home, `/Users/<name>` is used as a heuristic. */
export function abbreviatePath(p: string, homeDir?: string | null): string {
  if (!p) return p
  if (homeDir) {
    if (p === homeDir) return '~'
    if (p.startsWith(homeDir + '/')) return '~' + p.slice(homeDir.length)
    return p
  }
  const m = /^\/Users\/[^/]+(?=\/|$)/.exec(p)
  if (m) return '~' + p.slice(m[0].length)
  return p
}

export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

/** Validates a user-typed destination path before it is sent to the main process. */
export function validateDestinationPath(p: string): { ok: true } | { ok: false; reason: string } {
  const value = p.trim()
  if (value.length === 0) return { ok: false, reason: 'Enter a destination path.' }
  if (value.includes('\0')) return { ok: false, reason: 'The path contains an invalid character.' }
  if (value.startsWith('-')) return { ok: false, reason: 'The path may not start with “-”.' }
  if (!value.startsWith('/') && !value.startsWith('~/') && value !== '~')
    return { ok: false, reason: 'Use an absolute path (starting with / or ~/).' }
  if (value.split('/').some((segment) => segment === '..'))
    return { ok: false, reason: 'The path may not contain “..” segments.' }
  if (value.length > 1024) return { ok: false, reason: 'The path is too long.' }
  return { ok: true }
}

/** Expands a leading ~ using the known home dir (display → canonical). */
export function expandHome(p: string, homeDir: string | null | undefined): string {
  if (!homeDir) return p
  if (p === '~') return homeDir
  if (p.startsWith('~/')) return homeDir + p.slice(1)
  return p
}
