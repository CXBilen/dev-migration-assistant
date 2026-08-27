import { describe, expect, it } from 'vitest'
import { abbreviatePath, basename, dirname, expandHome, validateDestinationPath } from './paths'

describe('abbreviatePath', () => {
  it('abbreviates with a known home', () => {
    expect(abbreviatePath('/Users/cem/Documents/GitHub/looplift', '/Users/cem')).toBe(
      '~/Documents/GitHub/looplift',
    )
    expect(abbreviatePath('/Users/cem', '/Users/cem')).toBe('~')
    expect(abbreviatePath('/Users/cemx/foo', '/Users/cem')).toBe('/Users/cemx/foo')
    expect(abbreviatePath('/Volumes/Data/foo', '/Users/cem')).toBe('/Volumes/Data/foo')
  })
  it('falls back to the /Users/<name> heuristic', () => {
    expect(abbreviatePath('/Users/anyone/x')).toBe('~/x')
    expect(abbreviatePath('/opt/x')).toBe('/opt/x')
  })
})

describe('basename / dirname / expandHome', () => {
  it('splits paths', () => {
    expect(basename('/a/b/c/')).toBe('c')
    expect(basename('c')).toBe('c')
    expect(dirname('/a/b/c')).toBe('/a/b')
    expect(dirname('/a')).toBe('/')
  })
  it('expands ~', () => {
    expect(expandHome('~/x', '/Users/cem')).toBe('/Users/cem/x')
    expect(expandHome('~', '/Users/cem')).toBe('/Users/cem')
    expect(expandHome('/x', '/Users/cem')).toBe('/x')
    expect(expandHome('~/x', null)).toBe('~/x')
  })
})

describe('validateDestinationPath', () => {
  it('accepts absolute and ~ paths', () => {
    expect(validateDestinationPath('/Users/cem/Projects/x')).toEqual({ ok: true })
    expect(validateDestinationPath('~/Projects/x')).toEqual({ ok: true })
  })
  it('rejects unsafe or relative input', () => {
    expect(validateDestinationPath('')).toMatchObject({ ok: false })
    expect(validateDestinationPath('-rf')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('“-”') as string,
    })
    expect(validateDestinationPath('relative')).toMatchObject({ ok: false })
    expect(validateDestinationPath('/a/../b')).toMatchObject({ ok: false })
    expect(validateDestinationPath('/a\0b')).toMatchObject({ ok: false })
    expect(validateDestinationPath('/' + 'x'.repeat(1100))).toMatchObject({ ok: false })
  })
})
