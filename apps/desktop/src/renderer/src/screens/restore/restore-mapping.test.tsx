import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { MOCK_DEMO_PASSWORD } from '../../api/mock-api'
import { useRestoreWizard } from '../../stores/restore-wizard'
import { demoInspection, installMockApi, renderApp } from '../../test/helpers'

describe('Restore — mapping', () => {
  beforeEach(async () => {
    const api = installMockApi()
    const inspection = await demoInspection(api)
    const store = useRestoreWizard.getState()
    store.setBackupPath(inspection.path)
    store.setPassword(MOCK_DEMO_PASSWORD)
    store.setInspection(inspection)
  })

  it('shows an exact match by default and a remap message when the path changes', async () => {
    renderApp('/restore/mapping')
    expect(screen.getByTestId('mapping-exact-0')).toHaveTextContent('Exact path match')
    expect(screen.getByTestId('mapping-exact-1')).toHaveTextContent('Exact path match')
    expect(screen.getByTestId('mapping-input-0')).toHaveValue(
      '/Users/cem/Documents/GitHub/looplift',
    )
    expect(screen.queryByTestId('mapping-remap-report')).not.toBeInTheDocument()
    // The existence check flags the directory that exists on "this" Mac.
    await screen.findByTestId('mapping-exists-1')

    fireEvent.change(screen.getByTestId('mapping-input-0'), {
      target: { value: '/Users/newuser/Projects/looplift' },
    })
    expect(screen.getByTestId('mapping-remap-0')).toHaveTextContent(
      '187 Claude sessions require safe path remapping',
    )
    expect(screen.queryByTestId('mapping-exact-0')).not.toBeInTheDocument()
    expect(useRestoreWizard.getState().mappings[0]?.newPath).toBe(
      '/Users/newuser/Projects/looplift',
    )

    // Debounced preview from the API shows the aggregate report.
    await waitFor(
      () =>
        expect(screen.getByTestId('mapping-remap-report')).toHaveTextContent(
          'structured references will be rewritten safely',
        ),
      {
        timeout: 3000,
      },
    )
    expect(screen.getByTestId('mapping-remap-0')).toHaveTextContent('safe automatic remap')
    expect(screen.getByTestId('mapping-remap-report')).toHaveTextContent(
      'Claude Code sessions (looplift)',
    )
    expect(screen.getByTestId('mapping-summary')).toHaveTextContent('1 project will be remapped')
  })

  it('rejects invalid destinations and disables Continue', () => {
    renderApp('/restore/mapping')
    fireEvent.change(screen.getByTestId('mapping-input-1'), { target: { value: '-rf' } })
    expect(screen.getByTestId('mapping-status-1')).toHaveTextContent('may not start with')
    expect(screen.getByTestId('mapping-continue')).toBeDisabled()
    fireEvent.change(screen.getByTestId('mapping-input-1'), { target: { value: 'relative/path' } })
    expect(screen.getByTestId('mapping-status-1')).toHaveTextContent('Use an absolute path')
    fireEvent.change(screen.getByTestId('mapping-input-1'), {
      target: { value: '/Users/cem/Projects/../x' },
    })
    expect(screen.getByTestId('mapping-status-1')).toHaveTextContent('may not contain')
    fireEvent.change(screen.getByTestId('mapping-input-1'), {
      target: { value: '~/Projects/playagain' },
    })
    expect(screen.getByTestId('mapping-continue')).toBeEnabled()
  })

  it('uses the native chooser and starts planning', async () => {
    renderApp('/restore/mapping')
    fireEvent.click(screen.getByTestId('mapping-choose-1'))
    await waitFor(() =>
      expect(screen.getByTestId('mapping-input-1')).toHaveValue('/Users/cem/Projects/playagain'),
    )
    fireEvent.click(screen.getByTestId('mapping-continue'))
    await screen.findByTestId('screen-restore-preflight')
    expect(useRestoreWizard.getState().planJobId).toMatch(/^job_mock_/)
    // The fast mock finishes planning and the plan renders with its collisions.
    await screen.findByTestId('plan-execute')
    expect(screen.getByTestId('plan-preflight')).toBeInTheDocument()
  })
})
