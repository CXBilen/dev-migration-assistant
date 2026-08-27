import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, formatNumber, plural } from './format'

describe('formatBytes', () => {
  it('formats like Finder (base 10)', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1_000)).toBe('1 KB')
    expect(formatBytes(48_200_000)).toBe('48.2 MB')
    expect(formatBytes(1_234_567)).toBe('1.2 MB')
    expect(formatBytes(142_300_000)).toBe('142 MB')
    expect(formatBytes(1_240_000_000)).toBe('1.2 GB')
  })
  it('handles missing and invalid input', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('formatDuration / formatNumber / plural', () => {
  it('formats durations', () => {
    expect(formatDuration(400)).toBe('<1s')
    expect(formatDuration(6_200)).toBe('6s')
    expect(formatDuration(83_000)).toBe('1m 23s')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
  })
  it('formats numbers and plurals', () => {
    expect(formatNumber(1204)).toBe('1,204')
    expect(plural(1, 'session')).toBe('1 session')
    expect(plural(2, 'session')).toBe('2 sessions')
    expect(plural(3, 'match', 'matches')).toBe('3 matches')
  })
})
