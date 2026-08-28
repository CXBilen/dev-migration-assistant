import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ROUTES } from '../../lib/routes'
import { useBackupWizard } from '../../stores/backup-wizard'
import { installMockApi, mockScan, renderApp } from '../../test/helpers'

describe('Backup review: select everything', () => {
  beforeEach(() => {
    installMockApi()
    useBackupWizard.getState().setScan(mockScan())
  })

  it('warns before including sensitive files and weak matches, and cancelling keeps the selection', async () => {
    renderApp(ROUTES.backupReview)
    const before = new Set(useBackupWizard.getState().selectedArtifactIds)
    expect(before.has('files:proj_looplift:env')).toBe(false)

    fireEvent.click(screen.getByTestId('review-select-all'))
    const dialog = await screen.findByTestId('review-select-all-dialog')
    expect(dialog).toHaveTextContent('.env.local')
    expect(dialog).toHaveTextContent(/needs review/i)

    fireEvent.click(screen.getByTestId('review-select-all-dialog-cancel'))
    await waitFor(() =>
      expect(screen.queryByTestId('review-select-all-dialog')).not.toBeInTheDocument(),
    )
    expect(useBackupWizard.getState().selectedArtifactIds).toEqual(before)
  })

  it('confirming selects everything selectable, including sensitive files', async () => {
    renderApp(ROUTES.backupReview)
    fireEvent.click(screen.getByTestId('review-select-all'))
    fireEvent.click(await screen.findByTestId('review-select-all-dialog-confirm'))
    await waitFor(() =>
      expect(screen.queryByTestId('review-select-all-dialog')).not.toBeInTheDocument(),
    )
    const selected = useBackupWizard.getState().selectedArtifactIds
    expect(selected.has('files:proj_looplift:env')).toBe(true)
    expect(selected.has('claude:proj_playagain:sessions-weak')).toBe(true)
    expect(selected.has('claude:global:credentials')).toBe(false)
    expect(selected.has('files:proj_looplift:node-modules')).toBe(false)
    expect(screen.getByTestId('review-total-sessions')).toHaveTextContent('293')

    // Reset to defaults undoes it.
    fireEvent.click(screen.getByTestId('review-reset-defaults'))
    expect(useBackupWizard.getState().selectedArtifactIds.has('files:proj_looplift:env')).toBe(
      false,
    )
  })

  it('selects immediately when nothing sensitive or weak would be added', async () => {
    const scan = mockScan()
    for (const p of scan.projects)
      for (const r of p.providers)
        r.artifacts = r.artifacts.filter(
          (a) => a.sensitivity !== 'sensitive' && a.meta['confidence'] !== 'weak',
        )
    scan.global = scan.global.map((r) => ({
      ...r,
      artifacts: r.artifacts.filter((a) => a.sensitivity !== 'sensitive'),
    }))
    useBackupWizard.getState().setScan(scan)
    renderApp(ROUTES.backupReview)
    fireEvent.click(screen.getByTestId('review-select-all'))
    expect(screen.queryByTestId('review-select-all-dialog')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(useBackupWizard.getState().selectedArtifactIds.size).toBeGreaterThan(0),
    )
  })
})
