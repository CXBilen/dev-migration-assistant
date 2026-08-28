import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatBytes } from '../../lib/format'
import { ROUTES } from '../../lib/routes'
import { computeTotals } from '../../lib/totals'
import { useBackupWizard } from '../../stores/backup-wizard'
import { installMockApi, mockScan, renderApp } from '../../test/helpers'

describe('Backup Review', () => {
  beforeEach(() => {
    installMockApi()
  })

  it('redirects to project selection without a scan', () => {
    renderApp('/backup/review')
    expect(screen.getByTestId('screen-projects')).toBeInTheDocument()
  })

  it('renders provider sections and totals from the scan defaults', () => {
    const scan = mockScan()
    useBackupWizard.getState().setScan(scan)
    renderApp('/backup/review')
    const totals = computeTotals(scan, useBackupWizard.getState().selectedArtifactIds)
    expect(screen.getByTestId('review-total-sessions')).toHaveTextContent('281')
    expect(screen.getByTestId('review-total-worktrees')).toHaveTextContent('3')
    expect(screen.getByTestId('review-total-size')).toHaveTextContent(formatBytes(totals.bytes))
    expect(screen.getByTestId('review-proj_looplift-git')).toBeInTheDocument()
    expect(screen.getByTestId('review-proj_looplift-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('review-global')).toBeInTheDocument()
    // Weak Claude match is surfaced with a badge and excluded by default.
    expect(
      screen.getByTestId('needs-review-claude:proj_playagain:sessions-weak'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('artifact-checkbox-claude:proj_playagain:sessions-weak'),
    ).toHaveAttribute('data-state', 'unchecked')
    // Sensitive .env.local is excluded by default; non-selectable ephemeral items are hidden unless the pref is on.
    expect(screen.getByTestId('artifact-checkbox-files:proj_looplift:env')).toHaveAttribute(
      'data-state',
      'unchecked',
    )
    expect(
      screen.queryByTestId('artifact-files:proj_looplift:node-modules'),
    ).not.toBeInTheDocument()
  })

  it('toggles artifacts and recomputes totals', () => {
    const scan = mockScan()
    useBackupWizard.getState().setScan(scan)
    renderApp('/backup/review')

    fireEvent.click(screen.getByTestId('artifact-checkbox-git:proj_looplift:worktrees'))
    expect(screen.getByTestId('review-total-worktrees')).toHaveTextContent('1')
    expect(useBackupWizard.getState().selectedArtifactIds.has('git:proj_looplift:worktrees')).toBe(
      false,
    )

    fireEvent.click(screen.getByTestId('artifact-checkbox-claude:proj_playagain:sessions-weak'))
    expect(screen.getByTestId('review-total-sessions')).toHaveTextContent('293')

    const before = useBackupWizard.getState().selectedArtifactIds
    fireEvent.click(screen.getByTestId('artifact-checkbox-files:proj_looplift:env'))
    const after = useBackupWizard.getState().selectedArtifactIds
    expect(after.has('files:proj_looplift:env')).toBe(true)
    expect(computeTotals(scan, after).bytes).toBe(computeTotals(scan, before).bytes + 1240)
    expect(screen.getByTestId('review-total-size')).toHaveTextContent(
      formatBytes(computeTotals(scan, after).bytes),
    )

    fireEvent.click(screen.getByTestId('review-reset-defaults'))
    expect(screen.getByTestId('review-total-worktrees')).toHaveTextContent('3')
    expect(screen.getByTestId('review-total-sessions')).toHaveTextContent('281')
  })

  it('continues to the security review', () => {
    useBackupWizard.getState().setScan(mockScan())
    renderApp('/backup/review')
    fireEvent.click(screen.getByTestId('review-continue'))
    expect(screen.getByTestId('screen-security')).toBeInTheDocument()
  })
})

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
