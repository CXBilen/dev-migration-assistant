/** Human labels for job phases. Unknown phases fall back to a title-cased version of the id. */
const PHASE_LABELS: Record<string, string> = {
  IDLE: 'Waiting',
  DISCOVERING: 'Discovering projects',
  SCANNING: 'Scanning',
  PLANNING: 'Planning',
  SECURITY_REVIEW: 'Security review',
  COLLECTING: 'Collecting',
  PACKING: 'Packing',
  ENCRYPTING: 'Encrypting',
  VERIFYING: 'Verifying',
  INSPECT: 'Inspecting',
  DECRYPT: 'Decrypting',
  VALIDATE: 'Validating',
  MAP_PATHS: 'Mapping paths',
  PREFLIGHT: 'Preflight checks',
  STAGE: 'Preparing',
  RESTORE_REPOSITORIES: 'Repositories',
  RESTORE_WORKTREE_STATE: 'Worktree state',
  RESTORE_CLAUDE: 'Claude Code',
  RESTORE_PROJECT_FILES: 'Project files',
  RESTORE_RUNTIME: 'Development runtime',
  VERIFY: 'Verifying',
  REPORT: 'Report',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
}

export const TERMINAL_PHASES = new Set(['COMPLETE', 'FAILED', 'CANCELLED'])

export function phaseLabel(phase: string | undefined): string {
  if (!phase) return ''
  const known = PHASE_LABELS[phase]
  if (known) return known
  return phase
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
}

export const BACKUP_RUN_PHASES = ['COLLECTING', 'PACKING', 'ENCRYPTING', 'VERIFYING'] as const
export const RESTORE_PLAN_PHASES = [
  'INSPECT',
  'DECRYPT',
  'VALIDATE',
  'MAP_PATHS',
  'PREFLIGHT',
] as const
export const RESTORE_RUN_PHASES = [
  'RESTORE_REPOSITORIES',
  'RESTORE_PROJECT_FILES',
  'RESTORE_CLAUDE',
  'RESTORE_RUNTIME',
  'VERIFY',
] as const

export type ChecklistStatus = 'pending' | 'running' | 'done' | 'warn' | 'failed' | 'skipped'
export type JobStatusLike = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | undefined

/**
 * Derives a status for each expected phase. `lastPhase` is the last non-terminal phase the job
 * reported (the caller derives it from events so a FAILED job still shows where it stopped).
 * Phases before it are done, it is running/failed/skipped, later ones are pending. A phase that
 * comes after every listed phase (REPORT) marks all of them done.
 */
export function phaseChecklist(
  phases: readonly string[],
  lastPhase: string | undefined,
  status: JobStatusLike,
  phasesAfter: readonly string[] = ['REPORT'],
): { id: string; label: string; status: ChecklistStatus }[] {
  const idx = lastPhase ? phases.indexOf(lastPhase) : -1
  const pastAll = lastPhase !== undefined && phasesAfter.includes(lastPhase)
  return phases.map((phase, i) => {
    let s: ChecklistStatus = 'pending'
    if (status === 'completed' || pastAll) s = 'done'
    else if (idx !== -1 && i < idx) s = 'done'
    else if (idx !== -1 && i === idx)
      s = status === 'failed' ? 'failed' : status === 'cancelled' ? 'skipped' : 'running'
    return { id: phase, label: phaseLabel(phase), status: s }
  })
}
