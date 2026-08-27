import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { MOCK_PROJECT_PATHS } from '../../api/mock-data'
import { parseJobResult } from '../../lib/job-result'
import { useBackupWizard } from '../../stores/backup-wizard'
import { installMockApi, mockScan, renderApp } from '../../test/helpers'
import { SENSITIVE_COPY } from './security-review'

describe('Security Review', () => {
  beforeEach(() => {
    installMockApi()
    useBackupWizard.getState().setScan(mockScan())
  })

  it('blocks the start button until the password is long enough, confirmed, and an output path is chosen', async () => {
    renderApp('/backup/security')
    const start = screen.getByTestId('security-start')
    const password = screen.getByTestId('security-password')
    const confirm = screen.getByTestId('security-password-confirm')
    await waitFor(() =>
      expect(screen.getByTestId('security-label')).toHaveValue('MacBook Pro — 2026-08-27'),
    )
    expect(start).toBeDisabled()

    fireEvent.change(password, { target: { value: 'short' } })
    fireEvent.change(confirm, { target: { value: 'short' } })
    expect(screen.getByTestId('security-password-strength')).toHaveTextContent(
      '3 more characters needed',
    )
    expect(start).toBeDisabled()

    fireEvent.change(password, { target: { value: 'correct horse battery' } })
    expect(start).toBeDisabled()
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()

    fireEvent.change(confirm, { target: { value: 'correct horse battery' } })
    expect(screen.queryByText('Passwords do not match.')).not.toBeInTheDocument()
    expect(start).toBeDisabled() // no output chosen yet
    expect(screen.getByTestId('security-output-path')).toHaveTextContent('')

    fireEvent.click(screen.getByTestId('security-choose-output'))
    await waitFor(() =>
      expect(screen.getByTestId('security-output-path')).toHaveTextContent(
        '/Users/cem/Desktop/MacBook Pro — 2026-08-27.devbackup',
      ),
    )
    expect(start).toBeEnabled()

    fireEvent.change(screen.getByTestId('security-label'), { target: { value: '' } })
    expect(start).toBeDisabled()
    fireEvent.change(screen.getByTestId('security-label'), { target: { value: 'Work Mac' } })
    expect(start).toBeEnabled()
  })

  it('groups included / sensitive / excluded / credentials and lets sensitive files opt in', () => {
    renderApp('/backup/security')
    expect(screen.getByTestId('security-sensitive')).toHaveTextContent(SENSITIVE_COPY)
    expect(screen.getByTestId('security-credentials')).toHaveTextContent(
      'Credentials — re-authentication required on the destination Mac',
    )
    expect(screen.getByTestId('security-credentials')).toHaveTextContent(
      'Claude Code sign-in (macOS Keychain)',
    )
    expect(screen.getByTestId('security-included')).toHaveTextContent('Claude Code sessions (187)')
    expect(screen.getByTestId('security-excluded')).toHaveTextContent(/Possible sessions in/)

    const toggle = screen.getByTestId('security-sensitive-files:proj_looplift:env')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(useBackupWizard.getState().selectedArtifactIds.has('files:proj_looplift:env')).toBe(true)
    expect(screen.getByTestId('security-summary')).toHaveTextContent('1 sensitive file included')
  })

  it('starts the backup job and moves to the progress screen', async () => {
    // The scan must come from the API: the main process only creates backups for scan sessions it produced.
    const api = installMockApi()
    const { jobId } = await api.projects.scan({ paths: MOCK_PROJECT_PATHS, includeGlobal: true })
    const scan = parseJobResult('scan', await api.jobs.waitFor(jobId))
    expect(scan).not.toBeNull()
    useBackupWizard.getState().setScan(scan)
    renderApp('/backup/security')
    fireEvent.change(screen.getByTestId('security-password'), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.change(screen.getByTestId('security-password-confirm'), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.click(screen.getByTestId('security-choose-output'))
    await waitFor(() => expect(screen.getByTestId('security-start')).toBeEnabled())
    fireEvent.click(screen.getByTestId('security-start'))
    await screen.findByTestId('screen-backup-progress')
    expect(useBackupWizard.getState().backupJobId).toMatch(/^job_mock_/)
    // The fast mock completes the job; the wizard ends on the verified screen.
    await screen.findByTestId('backup-complete')
    expect(screen.getByTestId('backup-sessions-count')).toHaveTextContent('281')
    expect(screen.getByTestId('backup-projects-count')).toHaveTextContent('2')
    expect(screen.getByTestId('backup-worktrees-count')).toHaveTextContent('3')
    expect(screen.getByTestId('backup-file-name')).toHaveTextContent('.devbackup')
    fireEvent.click(screen.getByTestId('backup-done'))
    expect(screen.getByTestId('home')).toBeInTheDocument()
    expect(useBackupWizard.getState().password).toBe('')
  })
})
