import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { IpcError } from '@devmig/ipc-contracts'
import { setApiForTests } from '../../api'
import { MOCK_DEMO_PASSWORD } from '../../api/mock-api'
import { useRestoreWizard } from '../../stores/restore-wizard'
import { installMockApi, renderApp } from '../../test/helpers'

describe('Restore — open backup', () => {
  beforeEach(() => {
    installMockApi()
  })

  it('shows header info, rejects a wrong password inline, then unlocks', async () => {
    renderApp('/restore')
    fireEvent.click(screen.getByTestId('restore-select-file'))
    await screen.findByTestId('restore-format-version')
    expect(screen.getByTestId('restore-format-version')).toHaveTextContent('1')
    expect(screen.getByTestId('restore-kdf')).toHaveTextContent('argon2id · 256 MiB · 3 iterations')
    expect(screen.getByTestId('restore-unlock')).toBeDisabled()

    fireEvent.change(screen.getByTestId('restore-password'), {
      target: { value: 'not-the-password' },
    })
    expect(screen.getByTestId('restore-unlock')).toBeEnabled()
    fireEvent.click(screen.getByTestId('restore-unlock'))
    await screen.findByText('That password did not unlock this backup.')
    expect(screen.getByTestId('screen-restore-open')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('restore-password'), {
      target: { value: MOCK_DEMO_PASSWORD },
    })
    expect(screen.queryByText('That password did not unlock this backup.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('restore-unlock'))
    await screen.findByTestId('screen-restore-contents')
    expect(useRestoreWizard.getState().inspection?.manifest.projects).toHaveLength(2)
    expect(screen.getByTestId('contents-machine')).toHaveTextContent('MacBook Pro')
    expect(screen.getByTestId('contents-project-proj_looplift')).toHaveTextContent(
      '187 sessions · 2 worktrees',
    )
  })

  it('explains an unsupported format version and keeps Unlock disabled', async () => {
    renderApp('/restore')
    fireEvent.click(screen.getByTestId('restore-select-file')) // demo file
    await screen.findByTestId('restore-format-version')
    fireEvent.click(screen.getByTestId('restore-select-file')) // second pick: unsupported file
    await waitFor(() =>
      expect(screen.getByTestId('restore-format-version')).toHaveTextContent('99'),
    )
    expect(screen.getByTestId('restore-unsupported')).toHaveTextContent(
      'Unsupported backup version',
    )
    expect(screen.getByTestId('restore-unsupported-hint')).toHaveTextContent(
      /Update Dev Migration Assistant/,
    )
    expect(screen.getByTestId('restore-unlock')).toBeDisabled()
  })

  it('shows an actionable error when the header cannot be read', async () => {
    const api = installMockApi()
    setApiForTests({
      ...api,
      backups: {
        ...api.backups,
        readHeader: () =>
          Promise.reject(
            new IpcError(
              'ARCHIVE_INVALID',
              'Not a .devbackup file (bad magic).',
              'Choose a file created by Dev Migration Assistant.',
            ),
          ),
      },
    })
    renderApp('/restore')
    fireEvent.click(screen.getByTestId('restore-select-file'))
    await screen.findByTestId('restore-header-failed')
    expect(screen.getByTestId('error-panel')).toHaveTextContent('Backup file rejected')
    expect(screen.getByTestId('error-panel-hint')).toHaveTextContent(
      'Choose a file created by Dev Migration Assistant.',
    )
    expect(screen.queryByTestId('restore-password')).not.toBeInTheDocument()
    expect(screen.getByTestId('restore-unlock')).toBeDisabled()
    // Choosing another file is still possible from the same screen.
    expect(screen.getByTestId('restore-select-file')).toBeEnabled()
  })
})
