import type { DevMigrationApi } from '@devmig/ipc-contracts'
import type { BackupInspection, ScanSession } from '@devmig/model'
import { render, type RenderResult } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { setApiForTests } from '../api'
import {
  MOCK_DEMO_BACKUP_PATH,
  MOCK_DEMO_PASSWORD,
  createMockApi,
  type MockApiOptions,
} from '../api/mock-api'
import { MOCK_PROJECT_PATHS, buildMockScanSession } from '../api/mock-data'
import { AppRoutes } from '../App'
import { resetHomeDirCache } from '../hooks/use-home-dir'
import { useBackupWizard } from '../stores/backup-wizard'
import { useJobsStore } from '../stores/jobs'
import { useRestoreWizard } from '../stores/restore-wizard'

export const FIXED_NOW = '2026-08-27T10:00:00.000Z'

/** Installs a fast mock API (all simulated delays collapse to the event loop) and resets stores. */
export function installMockApi(options: MockApiOptions = {}): DevMigrationApi {
  const api = createMockApi({ timeScale: 0, now: () => new Date(FIXED_NOW), ...options })
  setApiForTests(api)
  resetStores()
  return api
}

export function resetStores(): void {
  resetHomeDirCache()
  useBackupWizard.getState().reset()
  useRestoreWizard.getState().reset()
  useJobsStore.setState({ jobs: {} })
}

/** Renders the whole route table at a given path — the closest thing to the real app without Electron. */
export function renderApp(path: string): RenderResult {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

export function mockScan(): ScanSession {
  return buildMockScanSession(MOCK_PROJECT_PATHS, true, 'scan_test', FIXED_NOW)
}

/** Unlocks the demo backup through the mock API and returns its inspection. */
export async function demoInspection(api: DevMigrationApi): Promise<BackupInspection> {
  return api.backups.inspect({ path: MOCK_DEMO_BACKUP_PATH, password: MOCK_DEMO_PASSWORD })
}
