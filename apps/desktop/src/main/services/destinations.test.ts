import { describe, expect, it } from 'vitest'
import { ApprovedPaths } from './approved-paths'
import { validateDestinationPath, validateReadPath } from './destinations'

const HOME = '/Users/alice'

describe('validateReadPath', () => {
  it('expands ~, canonicalizes and rejects relative, empty, NUL and ".." paths', () => {
    expect(validateReadPath('~/demo/', HOME)).toBe('/Users/alice/demo')
    expect(validateReadPath('/Users/bob/x/./y', HOME)).toBe('/Users/bob/x/y')
    for (const bad of [
      '',
      '   ',
      'relative/x',
      '/a\0b',
      '/Users/alice/../root',
      'x'.repeat(5000),
    ]) {
      expect(() => validateReadPath(bad, HOME)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      )
    }
  })
})

describe('validateDestinationPath', () => {
  it('accepts paths inside home, /Users and /Volumes and rejects everything else', () => {
    const opts = { homeDir: HOME }
    expect(validateDestinationPath('~/Developer/demo', opts)).toBe('/Users/alice/Developer/demo')
    expect(validateDestinationPath('/Users/bob/demo', opts)).toBe('/Users/bob/demo')
    expect(validateDestinationPath('/Volumes/Ext/demo', opts)).toBe('/Volumes/Ext/demo')
    for (const bad of ['/tmp/demo', '/private/var/demo', '/opt/demo', '/']) {
      expect(() => validateDestinationPath(bad, opts)).toThrow(
        expect.objectContaining({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' }),
      )
    }
  })

  it('refuses the roots themselves', () => {
    const opts = { homeDir: HOME }
    for (const root of ['/Users', '/Volumes', '/Users/alice', '~']) {
      expect(() => validateDestinationPath(root, opts)).toThrow(
        expect.objectContaining({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' }),
      )
    }
  })

  it('accepts dialog-approved paths and extra roots outside the defaults', () => {
    const approved = new ApprovedPaths(HOME)
    approved.approve('/tmp/picked/')
    expect(validateDestinationPath('/tmp/picked', { homeDir: HOME, approved })).toBe('/tmp/picked')
    expect(() => validateDestinationPath('/tmp/picked/child', { homeDir: HOME, approved })).toThrow(
      expect.objectContaining({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' }),
    )
    expect(
      validateDestinationPath('/private/tmp/e2e/home/demo', {
        homeDir: HOME,
        extraRoots: ['/private/tmp/e2e'],
      }),
    ).toBe('/private/tmp/e2e/home/demo')
  })

  it('does not treat a sibling with a shared prefix as inside a root', () => {
    expect(() => validateDestinationPath('/Users-evil/demo', { homeDir: HOME })).toThrow(
      expect.objectContaining({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' }),
    )
    expect(() => validateDestinationPath('/Users/alice-evil/demo', { homeDir: HOME })).not.toThrow() // still under /Users
  })
})

describe('ApprovedPaths', () => {
  it('stores canonical paths and evicts the oldest beyond the cap', () => {
    const approved = new ApprovedPaths(HOME)
    expect(approved.approve('~/x/')).toBe('/Users/alice/x')
    expect(approved.has('/Users/alice/x')).toBe(true)
    expect(approved.has('/Users/alice/x/')).toBe(true)
    expect(approved.has('/Users/alice/y')).toBe(false)
    expect(approved.has('')).toBe(false)
    for (let i = 0; i < 600; i += 1) approved.approve(`/Users/alice/p${i}`)
    expect(approved.size()).toBeLessThanOrEqual(512)
    expect(approved.has('/Users/alice/x')).toBe(false)
    expect(approved.has('/Users/alice/p599')).toBe(true)
  })
})
