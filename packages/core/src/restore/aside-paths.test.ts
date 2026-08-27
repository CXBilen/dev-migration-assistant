import { describe, expect, it } from 'vitest'
import { approveAsideRoots, collectAsidePaths, isAsideOf } from './aside-paths'

describe('collectAsidePaths', () => {
  it('finds asidePaths arrays and backupAsidePath strings at any depth, deduped', () => {
    const state = {
      asidePaths: ['/a.devmig-backup-1', '', 42],
      backupAsidePath: '/b.devmig-backup-2',
      worktrees: [
        { backupAsidePath: '/c.devmig-backup-3' },
        { backupAsidePath: '/c.devmig-backup-3' },
      ],
      nested: { deeper: { asidePaths: ['/d.devmig-backup-4'] } },
      other: 'ignored',
    }
    expect(collectAsidePaths(state)).toEqual([
      '/a.devmig-backup-1',
      '/b.devmig-backup-2',
      '/c.devmig-backup-3',
      '/d.devmig-backup-4',
    ])
    expect(collectAsidePaths(null)).toEqual([])
    expect(collectAsidePaths('x')).toEqual([])
  })

  it('survives cycles', () => {
    const state: Record<string, unknown> = { asidePaths: ['/x.devmig-backup'] }
    state.self = state
    expect(collectAsidePaths(state)).toEqual(['/x.devmig-backup'])
  })
})

describe('isAsideOf', () => {
  it('accepts only <root>.devmig-backup… siblings', () => {
    expect(isAsideOf('/home/me/app', '/home/me/app.devmig-backup-2026')).toBe(true)
    expect(isAsideOf('/home/me/app/', '/home/me/app.devmig-backup')).toBe(true)
    expect(isAsideOf('/home/me/app', '/home/me/app-other.devmig-backup')).toBe(false)
    expect(isAsideOf('/home/me/app', '/home/other/app.devmig-backup-1')).toBe(false)
    expect(isAsideOf('/home/me/app', '/home/me/app')).toBe(false)
  })
})

describe('approveAsideRoots', () => {
  const roots = ['/home/me/app', '/home/me/.claude']
  it('approves nothing unless a decision is backup-then-replace', () => {
    expect(approveAsideRoots(roots, ['/home/me/app.devmig-backup-1'], { c: 'skip' })).toEqual({
      approved: [],
      rejected: [],
    })
    expect(approveAsideRoots(roots, [], { c: 'backup-then-replace' })).toEqual({
      approved: [],
      rejected: [],
    })
  })
  it('approves sibling asides and paths inside roots; rejects everything else', () => {
    const result = approveAsideRoots(
      roots,
      [
        '/home/me/app.devmig-backup-1',
        '/home/me/app/.env.devmig-backup-2',
        '/home/me/.claude.devmig-backup-3',
        '/home/me/elsewhere.devmig-backup-4',
        '/etc/passwd',
        'relative.devmig-backup',
        '/home/me/app.devmig-backup-1',
      ],
      { c: 'backup-then-replace', d: 'skip' },
    )
    expect(result.approved).toEqual([
      '/home/me/app.devmig-backup-1',
      '/home/me/app/.env.devmig-backup-2',
      '/home/me/.claude.devmig-backup-3',
    ])
    expect(result.rejected).toEqual([
      '/home/me/elsewhere.devmig-backup-4',
      '/etc/passwd',
      'relative.devmig-backup',
    ])
  })
})
