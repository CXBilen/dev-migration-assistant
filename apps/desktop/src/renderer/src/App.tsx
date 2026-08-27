import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/app-shell'
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip'
import { ROUTES } from './lib/routes'
import { BackupCompleteScreen } from './screens/backup/backup-complete'
import { BackupProgressScreen } from './screens/backup/backup-progress'
import { BackupReviewScreen } from './screens/backup/backup-review'
import { ProjectScanScreen } from './screens/backup/project-scan'
import { SecurityReviewScreen } from './screens/backup/security-review'
import { SelectProjectsScreen } from './screens/backup/select-projects'
import { DiagnosticsScreen } from './screens/diagnostics'
import { HomeScreen } from './screens/home'
import { RestoreContentsScreen } from './screens/restore/restore-contents'
import { RestoreMappingScreen } from './screens/restore/restore-mapping'
import { RestoreOpenScreen } from './screens/restore/restore-open'
import { RestorePreflightScreen } from './screens/restore/restore-preflight'
import { RestoreProgressScreen } from './screens/restore/restore-progress'
import { RestoreReportScreen } from './screens/restore/restore-report'
import { SettingsScreen } from './screens/settings'

/** Route table. Every wizard screen guards its own prerequisites and redirects backwards when they are missing. */
export function AppRoutes(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={300}>
      <AppShell>
        <Routes>
          <Route path={ROUTES.home} element={<HomeScreen />} />
          <Route path={ROUTES.backupProjects} element={<SelectProjectsScreen />} />
          <Route path={ROUTES.backupScan} element={<ProjectScanScreen />} />
          <Route path={ROUTES.backupReview} element={<BackupReviewScreen />} />
          <Route path={ROUTES.backupSecurity} element={<SecurityReviewScreen />} />
          <Route path={ROUTES.backupProgress} element={<BackupProgressScreen />} />
          <Route path={ROUTES.backupComplete} element={<BackupCompleteScreen />} />
          <Route path={ROUTES.restore} element={<RestoreOpenScreen />} />
          <Route path={ROUTES.restoreContents} element={<RestoreContentsScreen />} />
          <Route path={ROUTES.restoreMapping} element={<RestoreMappingScreen />} />
          <Route path={ROUTES.restorePreflight} element={<RestorePreflightScreen />} />
          <Route path={ROUTES.restoreProgress} element={<RestoreProgressScreen />} />
          <Route path={ROUTES.restoreReport} element={<RestoreReportScreen />} />
          <Route path={ROUTES.settings} element={<SettingsScreen />} />
          <Route path={ROUTES.diagnostics} element={<DiagnosticsScreen />} />
          <Route path="*" element={<Navigate to={ROUTES.home} replace />} />
        </Routes>
      </AppShell>
    </TooltipProvider>
  )
}

/** HashRouter: the packaged app is served from file://, where history-based routing has no server. */
export function App(): React.JSX.Element {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  )
}
