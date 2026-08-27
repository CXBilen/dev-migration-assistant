import '@testing-library/jest-dom/vitest'
import '../test/setup'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PREF_SHOW_EPHEMERAL, readBoolPref, writeBoolPref } from '../lib/prefs'
import { useBackupWizard } from '../stores/backup-wizard'
import { installMockApi, mockScan, renderApp } from '../test/helpers'

describe('Settings', () => {
  beforeEach(() => {
    installMockApi()
    writeBoolPref(PREF_SHOW_EPHEMERAL, false)
  })
  afterEach(() => {
    writeBoolPref(PREF_SHOW_EPHEMERAL, false)
  })

  it('shows the default backup folder and persists the ephemeral toggle', async () => {
    renderApp('/settings')
    await waitFor(() =>
      expect(screen.getByTestId('settings-default-folder')).toHaveTextContent('~/Desktop'),
    )
    const toggle = screen.getByTestId('settings-show-ephemeral')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(readBoolPref(PREF_SHOW_EPHEMERAL, false)).toBe(true)
  })

  it('makes ephemeral state visible in the backup review when enabled', () => {
    useBackupWizard.getState().setScan(mockScan())
    renderApp('/backup/review')
    expect(
      screen.queryByTestId('artifact-files:proj_looplift:node-modules'),
    ).not.toBeInTheDocument()
    cleanup()
    writeBoolPref(PREF_SHOW_EPHEMERAL, true)
    renderApp('/backup/review')
    expect(screen.getByTestId('artifact-files:proj_looplift:node-modules')).toBeInTheDocument()
    expect(screen.getByTestId('artifact-files:proj_looplift:node-modules')).toHaveTextContent(
      'Not selectable',
    )
  })
})
