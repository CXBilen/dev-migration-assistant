import '@testing-library/jest-dom/vitest'
import '../test/setup'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { MOCK_DEMO_PASSWORD } from '../api/mock-api'
import { installMockApi, renderApp } from '../test/helpers'

describe('Diagnostics', () => {
  beforeEach(() => {
    installMockApi()
  })

  it('renders diagnostics, copies the report and verifies a backup', async () => {
    renderApp('/diagnostics')
    await waitFor(() =>
      expect(screen.getByTestId('diag-claude-version')).toHaveTextContent('2.1.247'),
    )
    expect(screen.getByTestId('diag-format-version')).toHaveTextContent('version 1')
    expect(screen.getByTestId('diag-claude-dir')).toHaveTextContent('~/.claude')
    expect(screen.getByTestId('diag-claude-dir')).toHaveTextContent('exists')
    expect(screen.getByTestId('diag-provider-git')).toHaveTextContent('available')
    expect(screen.getByTestId('diag-about')).toHaveTextContent('MIT license')

    fireEvent.click(screen.getByTestId('diag-copy'))
    await waitFor(() => expect(screen.getByTestId('diag-copy')).toHaveTextContent('Copied'))

    fireEvent.click(screen.getByTestId('diag-verify'))
    const password = await screen.findByTestId('diag-verify-password')
    expect(screen.getByTestId('diag-verify-start')).toBeDisabled()
    fireEvent.change(password, { target: { value: MOCK_DEMO_PASSWORD } })
    fireEvent.click(screen.getByTestId('diag-verify-start'))
    await waitFor(() =>
      expect(screen.getByTestId('diag-verify-result')).toHaveTextContent('Backup verified'),
    )
    expect(screen.queryByTestId('diag-verify-dialog')).not.toBeInTheDocument()
  })

  it('reports a wrong password as a failed verification job', async () => {
    renderApp('/diagnostics')
    fireEvent.click(screen.getByTestId('diag-verify'))
    fireEvent.change(await screen.findByTestId('diag-verify-password'), {
      target: { value: 'nope-nope' },
    })
    fireEvent.click(screen.getByTestId('diag-verify-start'))
    await waitFor(() =>
      expect(screen.getByTestId('diag-verify-result')).toHaveTextContent(
        'Verification did not complete',
      ),
    )
    expect(screen.getByTestId('error-panel')).toHaveTextContent('ARCHIVE_AUTH_FAILED')
  })
})
