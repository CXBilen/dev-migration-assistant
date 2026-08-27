import { describe, expect, it } from 'vitest'
import { orderProvidersForRestore, restorePhaseForProvider } from './provider-order'

describe('orderProvidersForRestore', () => {
  it('puts git, project-files, claude-code, runtime first and keeps the rest in registry order', () => {
    expect(
      orderProvidersForRestore(['zeta', 'claude-code', 'runtime', 'alpha', 'git', 'project-files']),
    ).toEqual(['git', 'project-files', 'claude-code', 'runtime', 'zeta', 'alpha'])
    expect(orderProvidersForRestore(['b', 'a', 'b'])).toEqual(['b', 'a'])
  })
})

describe('restorePhaseForProvider', () => {
  it('maps known providers to RestorePhase ids and slugs unknown ones', () => {
    expect(restorePhaseForProvider('git')).toBe('RESTORE_REPOSITORIES')
    expect(restorePhaseForProvider('project-files')).toBe('RESTORE_PROJECT_FILES')
    expect(restorePhaseForProvider('claude-code')).toBe('RESTORE_CLAUDE')
    expect(restorePhaseForProvider('runtime')).toBe('RESTORE_RUNTIME')
    expect(restorePhaseForProvider('vs-code.settings')).toBe('RESTORE_VS_CODE_SETTINGS')
    expect(restorePhaseForProvider('---')).toBe('RESTORE_PROVIDER')
  })
})
