/**
 * Fixed restore ordering (ARCHITECTURE.md "Restore Backup"): repositories first so worktrees exist,
 * then project files, then Claude Code state (which references the restored paths), then runtime info,
 * then any additional providers in registry order.
 */
export const RESTORE_PROVIDER_ORDER: readonly string[] = [
  'git',
  'project-files',
  'claude-code',
  'runtime',
]

const PHASE_BY_PROVIDER: Record<string, string> = {
  git: 'RESTORE_REPOSITORIES',
  'project-files': 'RESTORE_PROJECT_FILES',
  'claude-code': 'RESTORE_CLAUDE',
  runtime: 'RESTORE_RUNTIME',
}

/** Orders provider ids: the well-known ones first in fixed order, then the rest in the given (registry) order. */
export function orderProvidersForRestore(providerIds: readonly string[]): string[] {
  const unique = [...new Set(providerIds)]
  const known = RESTORE_PROVIDER_ORDER.filter((id) => unique.includes(id))
  const rest = unique.filter((id) => !RESTORE_PROVIDER_ORDER.includes(id))
  return [...known, ...rest]
}

/** Restore phase name for a provider: known phases from the RestorePhase enum, `RESTORE_<ID>` otherwise. */
export function restorePhaseForProvider(providerId: string): string {
  const known = PHASE_BY_PROVIDER[providerId]
  if (known) return known
  const slug = providerId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `RESTORE_${slug || 'PROVIDER'}`
}
