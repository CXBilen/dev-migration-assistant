import { describe, expect, it } from 'vitest'
import { BACKUP_RUN_PHASES, RESTORE_RUN_PHASES, phaseChecklist, phaseLabel } from './phases'

describe('phaseLabel', () => {
  it('maps known phases and title-cases unknown ones', () => {
    expect(phaseLabel('ENCRYPTING')).toBe('Encrypting')
    expect(phaseLabel('RESTORE_WORKTREE_STATE')).toBe('Worktree state')
    expect(phaseLabel('SOME_NEW_PHASE')).toBe('Some new phase')
    expect(phaseLabel(undefined)).toBe('')
  })
})

describe('phaseChecklist', () => {
  it('marks earlier phases done, the current one running, later ones pending', () => {
    const list = phaseChecklist(BACKUP_RUN_PHASES, 'ENCRYPTING', 'running', ['COMPLETE'])
    expect(list.map((p) => p.status)).toEqual(['done', 'done', 'running', 'pending'])
  })
  it('resolves terminal states', () => {
    expect(
      phaseChecklist(BACKUP_RUN_PHASES, 'VERIFYING', 'completed', ['COMPLETE']).every(
        (p) => p.status === 'done',
      ),
    ).toBe(true)
    expect(
      phaseChecklist(BACKUP_RUN_PHASES, 'PACKING', 'failed', ['COMPLETE']).map((p) => p.status),
    ).toEqual(['done', 'failed', 'pending', 'pending'])
    expect(
      phaseChecklist(BACKUP_RUN_PHASES, 'PACKING', 'cancelled', ['COMPLETE']).map((p) => p.status),
    ).toEqual(['done', 'skipped', 'pending', 'pending'])
  })
  it('treats phases after the list as everything done and unknown phases before it as pending', () => {
    expect(
      phaseChecklist(RESTORE_RUN_PHASES, 'REPORT', 'running').every((p) => p.status === 'done'),
    ).toBe(true)
    expect(
      phaseChecklist(RESTORE_RUN_PHASES, 'STAGE', 'running').every((p) => p.status === 'pending'),
    ).toBe(true)
    expect(
      phaseChecklist(RESTORE_RUN_PHASES, undefined, undefined).every((p) => p.status === 'pending'),
    ).toBe(true)
  })
})

describe('RESTORE_RUN_PHASES', () => {
  it('lists the restore run phases in the order the engine emits them', () => {
    expect(RESTORE_RUN_PHASES).toEqual([
      'RESTORE_REPOSITORIES',
      'RESTORE_PROJECT_FILES',
      'RESTORE_CLAUDE',
      'RESTORE_RUNTIME',
      'VERIFY',
    ])
    expect(phaseLabel('RESTORE_RUNTIME')).toBe('Development runtime')
  })
})
