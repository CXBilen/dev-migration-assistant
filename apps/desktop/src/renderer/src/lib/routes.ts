export const ROUTES = {
  home: '/',
  backupProjects: '/backup/projects',
  backupScan: '/backup/scan',
  backupReview: '/backup/review',
  backupSecurity: '/backup/security',
  backupProgress: '/backup/progress',
  backupComplete: '/backup/complete',
  restore: '/restore',
  restoreContents: '/restore/contents',
  restoreMapping: '/restore/mapping',
  restorePreflight: '/restore/preflight',
  restoreProgress: '/restore/progress',
  restoreReport: '/restore/report',
  settings: '/settings',
  diagnostics: '/diagnostics',
} as const

export interface WizardStep {
  path: string
  label: string
}

export const BACKUP_STEPS: WizardStep[] = [
  { path: ROUTES.backupProjects, label: 'Projects' },
  { path: ROUTES.backupScan, label: 'Scan' },
  { path: ROUTES.backupReview, label: 'Review' },
  { path: ROUTES.backupSecurity, label: 'Security' },
  { path: ROUTES.backupProgress, label: 'Backup' },
  { path: ROUTES.backupComplete, label: 'Done' },
]

export const RESTORE_STEPS: WizardStep[] = [
  { path: ROUTES.restore, label: 'Open backup' },
  { path: ROUTES.restoreContents, label: 'Contents' },
  { path: ROUTES.restoreMapping, label: 'Locations' },
  { path: ROUTES.restorePreflight, label: 'Preflight' },
  { path: ROUTES.restoreProgress, label: 'Restore' },
  { path: ROUTES.restoreReport, label: 'Report' },
]

export type WizardKind = 'backup' | 'restore' | null

export function wizardFor(pathname: string): {
  kind: WizardKind
  title: string
  steps: WizardStep[]
  index: number
} {
  if (pathname.startsWith('/backup')) {
    const index = BACKUP_STEPS.findIndex((s) => s.path === pathname)
    return { kind: 'backup', title: 'Create Backup', steps: BACKUP_STEPS, index }
  }
  if (pathname.startsWith('/restore')) {
    const index = RESTORE_STEPS.findIndex((s) => s.path === pathname)
    return { kind: 'restore', title: 'Restore Backup', steps: RESTORE_STEPS, index }
  }
  return { kind: null, title: '', steps: [], index: -1 }
}
