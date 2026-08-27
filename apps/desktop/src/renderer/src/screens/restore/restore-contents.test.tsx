import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useRestoreWizard } from '../../stores/restore-wizard'
import { demoInspection, installMockApi, renderApp } from '../../test/helpers'

describe('Restore — contents', () => {
  beforeEach(async () => {
    const api = installMockApi()
    const inspection = await demoInspection(api)
    const store = useRestoreWizard.getState()
    store.setBackupPath(inspection.path)
    store.setPassword('demo-password')
    store.setInspection(inspection)
  })

  it('selects every project artifact by default and toggles the global section', () => {
    renderApp('/restore/contents')
    const before = useRestoreWizard.getState().selectedArtifactIds.size
    expect(before).toBeGreaterThan(0)
    expect(screen.getByTestId('contents-include-global')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByTestId('contents-include-global'))
    expect(useRestoreWizard.getState().includeGlobal).toBe(true)
    expect(useRestoreWizard.getState().selectedArtifactIds.size).toBeGreaterThan(before)
    expect(screen.getByTestId('restore-artifact-claude:global:settings')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('contents-project-toggle-proj_playagain'))
    expect(useRestoreWizard.getState().selectedArtifactIds.has('git:proj_playagain:bundle')).toBe(
      false,
    )
    fireEvent.click(screen.getByTestId('contents-continue'))
    expect(screen.getByTestId('screen-restore-mapping')).toBeInTheDocument()
  })
})
