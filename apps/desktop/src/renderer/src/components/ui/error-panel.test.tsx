import '@testing-library/jest-dom/vitest'
import '../../test/setup'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { ErrorPanel } from './error-panel'

describe('ErrorPanel', () => {
  it('shows title, message, hint, code and a diagnostics link', () => {
    render(
      <MemoryRouter>
        <ErrorPanel
          error={{
            code: 'ARCHIVE_AUTH_FAILED',
            message: 'That password did not unlock this backup.',
            hint: 'Passwords are case-sensitive.',
            recoverable: true,
          }}
        />
      </MemoryRouter>,
    )
    const panel = screen.getByTestId('error-panel')
    expect(panel).toHaveAttribute('role', 'alert')
    expect(panel).toHaveTextContent('Could not unlock backup')
    expect(panel).toHaveTextContent('That password did not unlock this backup.')
    expect(screen.getByTestId('error-panel-hint')).toHaveTextContent(
      'Passwords are case-sensitive.',
    )
    expect(panel).toHaveTextContent('ARCHIVE_AUTH_FAILED')
    expect(screen.getByRole('link', { name: 'Open Diagnostics' })).toHaveAttribute(
      'href',
      '/diagnostics',
    )
  })

  it('renders cancellations as warnings without a diagnostics link', () => {
    render(
      <MemoryRouter>
        <ErrorPanel
          error={{ code: 'CANCELLED', message: 'The operation was cancelled.', recoverable: true }}
        />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('error-panel')).toHaveTextContent('Cancelled')
    expect(screen.queryByTestId('error-panel-hint')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open Diagnostics' })).not.toBeInTheDocument()
  })
})
