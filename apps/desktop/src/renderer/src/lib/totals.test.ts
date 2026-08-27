import { describe, expect, it } from 'vitest'
import { MOCK_PROJECT_PATHS, buildMockScanSession } from '../api/mock-data'
import { computeTotals, defaultSelectedIds, groupForSecurityReview } from './totals'

const scan = buildMockScanSession(MOCK_PROJECT_PATHS, true, 'scan_x', '2026-08-27T00:00:00.000Z')

describe('computeTotals', () => {
  it('counts sessions and worktrees from the default selection', () => {
    const totals = computeTotals(scan, defaultSelectedIds(scan))
    expect(totals.projects).toBe(2)
    expect(totals.sessions).toBe(281)
    expect(totals.worktrees).toBe(3)
    expect(totals.sensitiveIncluded).toBe(0)
    expect(totals.weakMatchesIncluded).toBe(0)
    expect(totals.bytes).toBeGreaterThan(200_000_000)
  })
  it('reflects opt-ins', () => {
    const ids = defaultSelectedIds(scan)
    ids.add('claude:proj_playagain:sessions-weak')
    ids.add('files:proj_looplift:env')
    const totals = computeTotals(scan, ids)
    expect(totals.sessions).toBe(293)
    expect(totals.sensitiveIncluded).toBe(1)
    expect(totals.weakMatchesIncluded).toBe(1)
  })
})

describe('groupForSecurityReview', () => {
  it('partitions artifacts and hides ephemeral state unless requested', () => {
    const groups = groupForSecurityReview(scan, defaultSelectedIds(scan), false)
    expect(groups.credentials.map((a) => a.id)).toEqual(['claude:global:credentials'])
    expect(groups.sensitive.map((a) => a.id).sort()).toEqual([
      'claude:proj_looplift:mcp',
      'claude:proj_playagain:mcp',
      'files:proj_looplift:env',
      'files:proj_playagain:env',
      'git:global:gitconfig',
    ])
    expect(groups.excluded.map((a) => a.id)).toEqual(['claude:proj_playagain:sessions-weak'])
    expect(groups.included.some((a) => a.id === 'claude:proj_looplift:sessions')).toBe(true)
    const verbose = groupForSecurityReview(scan, defaultSelectedIds(scan), true)
    expect(verbose.excluded.map((a) => a.id)).toContain('files:proj_looplift:node-modules')
    expect(verbose.excluded.map((a) => a.id)).toContain('claude:global:session-env')
  })
})
