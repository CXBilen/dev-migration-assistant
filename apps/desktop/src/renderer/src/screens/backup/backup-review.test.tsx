import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatBytes } from '../../lib/format'
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
