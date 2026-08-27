import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import type { RestorePlan } from '@devmig/model'
import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { MOCK_EXISTING_PATHS, buildMockRestorePlan } from '../../api/mock-data'
import { useRestoreWizard } from '../../stores/restore-wizard'
import { FIXED_NOW, demoInspection, installMockApi, renderApp } from '../../test/helpers'

async function seedPlan(mutate?: (plan: RestorePlan) => void): Promise<RestorePlan> {
  const api = installMockApi()
  const inspection = await demoInspection(api)
  const store = useRestoreWizard.getState()
  store.setBackupPath(inspection.path)
  store.setPassword('demo-password')
  store.setInspection(inspection)
  const { mappings, selectedArtifactIds } = useRestoreWizard.getState()
  const plan = buildMockRestorePlan(
    'plan_test',
    inspection.path,
    inspection.manifest,
    mappings,
    selectedArtifactIds,
    false,
    FIXED_NOW,
    (p) => {
      const known = MOCK_EXISTING_PATHS[p]
      return { exists: known !== undefined, isEmpty: known?.isEmpty ?? true }
    },
  )
  mutate?.(plan)
  useRestoreWizard.getState().setPlan(plan)
  return plan
}

describe('Restore — preflight', () => {
  beforeEach(() => {
    installMockApi()
  })

  it('disables Start restore when a blocking check fails', async () => {
    await seedPlan((plan) => {
      const disk = plan.preflight.find((c) => c.id === 'disk-space')
      if (disk) {
        disk.status = 'fail'
        disk.detail = 'Only 1.2 GB free; the backup needs 48 GB.'
      }
      plan.canProceed = false
    })
    renderApp('/restore/preflight')
    expect(screen.getByTestId('plan-execute')).toBeDisabled()
    expect(screen.getByTestId('plan-blocked')).toHaveTextContent(
      '1 blocking check failed: Disk space',
    )
    expect(screen.getByTestId('preflight-check-disk-space')).toHaveAttribute('data-status', 'fail')
    expect(screen.getByTestId('preflight-check-disk-space')).toHaveTextContent('Blocking')
  })

  it('enables Start restore when preflight passes and limits collision policies to the allowed set', async () => {
    // Plan through the API so the mock can execute it afterwards.
    const api = installMockApi()
    const inspection = await demoInspection(api)
    const store = useRestoreWizard.getState()
    store.setBackupPath(inspection.path)
    store.setPassword('demo-password')
    store.setInspection(inspection)
    const { mappings, selectedArtifactIds } = useRestoreWizard.getState()
    const { jobId } = await api.restore.plan({
      backupPath: inspection.path,
      password: 'demo-password',
      mappings,
      selectedArtifactIds: [...selectedArtifactIds],
      options: { defaultCollisionPolicy: 'skip', includeGlobal: false },
    })
    useRestoreWizard.getState().setPlanJob(jobId)
    await api.jobs.waitFor(jobId)
    renderApp('/restore/preflight')
    await screen.findByTestId('plan-execute')
    expect(useRestoreWizard.getState().plan?.canProceed).toBe(true)
    expect(screen.getByTestId('plan-execute')).toBeEnabled()
    expect(screen.getByTestId('preflight-check-claude-not-running')).toHaveAttribute(
      'data-status',
      'warn',
    )

    // playagain exists on this Mac → git + claude collisions with non-destructive defaults.
    const gitCollision = screen.getByTestId('collision-git:proj_playagain:repo-exists')
    expect(gitCollision).toHaveTextContent('Git repository already exists')
    expect(screen.getByTestId('collision-git:proj_playagain:repo-exists-skip')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(
      screen.queryByTestId('collision-git:proj_playagain:repo-exists-merge'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByTestId('collision-claude:proj_playagain:project-exists-merge'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('collision-claude:proj_playagain:project-exists-alternate-path'),
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('collision-git:proj_looplift:repo-exists')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByTestId('collision-git:proj_playagain:repo-exists-backup-then-replace'),
    )
    expect(useRestoreWizard.getState().collisionDecisions['git:proj_playagain:repo-exists']).toBe(
      'backup-then-replace',
    )
    expect(gitCollision).toHaveTextContent('moved aside, not deleted')

    fireEvent.click(screen.getByTestId('plan-execute'))
    await screen.findByTestId('screen-restore-progress')
    expect(useRestoreWizard.getState().executeJobId).toMatch(/^job_mock_/)
    await screen.findByTestId('restore-complete')
    expect(screen.getByTestId('report-attention')).toHaveTextContent(
      'Sign in to Claude Code on this Mac',
    )
    expect(screen.getByTestId('report-open-terminal-0')).toHaveTextContent(
      'Open looplift in Terminal',
    )
    expect(screen.getByTestId('report-outcome-proj_playagain-git')).toHaveAttribute(
      'data-status',
      'ok',
    )
    expect(screen.getByTestId('report-outcome-proj_playagain-claude-code')).toHaveAttribute(
      'data-status',
      'skipped',
    )
  })

  it('rejects executing a plan the main process does not know', async () => {
    await seedPlan()
    renderApp('/restore/preflight')
    fireEvent.click(screen.getByTestId('plan-execute'))
    await screen.findByTestId('error-panel')
    expect(screen.getByTestId('error-panel')).toHaveTextContent('RESTORE_PLAN_REJECTED')
    expect(screen.getByTestId('screen-restore-preflight')).toBeInTheDocument()
  })
})
