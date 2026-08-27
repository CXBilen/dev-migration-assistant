import { describe, expect, it } from 'vitest'
import { deterministicUuid, isUuidV4, seededBytes } from './ids'

describe('deterministicUuid', () => {
  it('produces valid, stable UUID v4 strings that differ by index and namespace', () => {
    const a = deterministicUuid('ns', 1)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(isUuidV4(a)).toBe(true)
    expect(deterministicUuid('ns', 1)).toBe(a)
    expect(deterministicUuid('ns', 2)).not.toBe(a)
    expect(deterministicUuid('other', 1)).not.toBe(a)
    expect(a.endsWith('000000000001')).toBe(true)
  })

  it('rejects out-of-range indexes', () => {
    expect(() => deterministicUuid('ns', -1)).toThrow(RangeError)
    expect(() => deterministicUuid('ns', 1.5)).toThrow(RangeError)
  })
})

describe('isUuidV4', () => {
  it('rejects non-v4 and malformed values', () => {
    expect(isUuidV4('00000000-0000-0000-0000-000000000000')).toBe(false)
    expect(isUuidV4('sess-0001')).toBe(false)
    expect(isUuidV4('123e4567-e89b-42d3-a456-426614174000')).toBe(true)
  })
})

describe('seededBytes', () => {
  it('is deterministic per seed and contains NUL bytes (binary for git)', () => {
    const a = seededBytes(42, 512)
    const b = seededBytes(42, 512)
    expect(a.equals(b)).toBe(true)
    expect(seededBytes(43, 512).equals(a)).toBe(false)
    expect(a.length).toBe(512)
    expect(a.includes(0)).toBe(true)
  })
})
