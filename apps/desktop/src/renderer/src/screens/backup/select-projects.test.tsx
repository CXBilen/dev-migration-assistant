import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi, renderApp } from '../../test/helpers'
import { useBackupWizard } from '../../stores/backup-wizard'

describe('Select Projects', () => {
  beforeEach(() => {
    installMockApi()
  })

  it('adds directories through the native dialog, removes them, and starts a scan', async () => {
    renderApp('/backup/projects')
    fireEvent.click(screen.getByTestId('projects-add'))
    await screen.findByTestId('projects-item-1')
    expect(screen.getByTestId('projects-item-0')).toHaveTextContent('looplift')
    expect(screen.getByTestId('projects-item-0')).toHaveTextContent('~/Documents/GitHub/looplift')
    expect(screen.getByTestId('projects-continue')).toBeEnabled()

    fireEvent.click(screen.getByTestId('projects-remove-1'))
    expect(screen.queryByTestId('projects-item-1')).not.toBeInTheDocument()
    expect(useBackupWizard.getState().selectedPaths).toHaveLength(1)

    fireEvent.click(screen.getByTestId('projects-continue'))
    await screen.findByTestId('screen-scan')
    expect(useBackupWizard.getState().scanJobId).toMatch(/^job_mock_/)
    // The fast mock finishes the scan; the wizard moves on to the review automatically.
    await screen.findByTestId('screen-review')
    expect(screen.getByTestId('review-project-proj_looplift')).toBeInTheDocument()
  })

  it('cancels a running scan', async () => {
    const api = installMockApi({ timeScale: 1 })
    useBackupWizard.getState().addPaths(['/Users/cem/Documents/GitHub/looplift'])
    const { jobId } = await api.projects.scan({
      paths: ['/Users/cem/Documents/GitHub/looplift'],
      includeGlobal: true,
    })
    useBackupWizard.getState().setScanJob(jobId)
    renderApp('/backup/scan')
    fireEvent.click(await screen.findByTestId('scan-cancel'))
    await waitFor(() =>
      expect(screen.getByTestId('scan-status')).toHaveTextContent('Scan cancelled'),
    )
    expect(screen.getByTestId('scan-retry')).toBeInTheDocument()
    expect(screen.getByTestId('error-panel')).toHaveTextContent('Cancelled')
  })
})
