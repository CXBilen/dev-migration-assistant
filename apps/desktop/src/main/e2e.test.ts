import { describe, expect, it } from 'vitest'
import { readE2EConfig } from './e2e'

describe('readE2EConfig', () => {
  it('is inert unless DEVMIG_E2E is exactly "1"', () => {
    expect(readE2EConfig({})).toBeNull()
    expect(readE2EConfig({ DEVMIG_E2E: 'true', DEVMIG_E2E_DIALOG_FILE: '/tmp/q.json' })).toBeNull()
    expect(readE2EConfig({ DEVMIG_E2E: '0' })).toBeNull()
  })

  it('reads absolute overrides and ignores relative or empty ones', () => {
    expect(
      readE2EConfig({
        DEVMIG_E2E: '1',
        DEVMIG_E2E_DIALOG_FILE: '/tmp/e2e/dialogs.json',
        DEVMIG_E2E_HOME_DIR: '/tmp/e2e/Users/alice/',
        DEVMIG_E2E_CLAUDE_CONFIG_DIR: 'relative/.claude',
        DEVMIG_E2E_CLAUDE_JSON_PATH: '',
        DEVMIG_WORK_DIR: '/tmp/e2e/work',
      }),
    ).toEqual({
      dialogFile: '/tmp/e2e/dialogs.json',
      homeDir: '/tmp/e2e/Users/alice',
      claudeConfigDir: null,
      claudeJsonPath: null,
      workDir: '/tmp/e2e/work',
    })
  })
})
