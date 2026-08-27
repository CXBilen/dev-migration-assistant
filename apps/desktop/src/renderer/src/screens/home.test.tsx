import '@testing-library/jest-dom/vitest'
import '../test/setup'
import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installMockApi, renderApp } from '../test/helpers'

describe('Home', () => {
  beforeEach(() => {
    installMockApi()
  })

  it('renders the thesis, both primary actions and the footer', () => {
    renderApp('/')
    expect(
      screen.getByText('Move your development environment without losing your context.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('home-create-backup')).toBeEnabled()
    expect(screen.getByTestId('home-restore-backup')).toBeEnabled()
    expect(screen.getByTestId('home-footer')).toHaveTextContent(
      'Local only · Encrypted · Open source',
    )
    expect(screen.getByTestId('home-diagnostics')).toHaveAttribute('href', '/diagnostics')
    expect(screen.getByTestId('home-settings')).toHaveAttribute('href', '/settings')
  })

  it('navigates to the backup wizard and shows the step indicator', () => {
    renderApp('/')
    fireEvent.click(screen.getByTestId('home-create-backup'))
    expect(screen.getByTestId('screen-projects')).toBeInTheDocument()
    expect(screen.getByTestId('projects-empty')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-step-0')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByTestId('projects-continue')).toBeDisabled()
  })

  it('navigates to the restore wizard and to diagnostics', () => {
    renderApp('/')
    fireEvent.click(screen.getByTestId('home-restore-backup'))
    expect(screen.getByTestId('screen-restore-open')).toBeInTheDocument()
    expect(screen.getByTestId('restore-select-file')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('sidebar-home'))
    fireEvent.click(screen.getByTestId('home-diagnostics'))
    expect(screen.getByTestId('screen-diagnostics')).toBeInTheDocument()
  })
})
