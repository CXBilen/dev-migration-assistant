import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalizePath,
  displayPath,
  expandHome,
  isPathWithin,
  isSafeArchivePath,
  pathsEqual,
  relativeWithin,
  safeJoin,
  toPosix,
} from './paths'

const home = '/Users/alice'

describe('paths', () => {
  it('expands ~ and abbreviates for display', () => {
    expect(expandHome('~', home)).toBe(home)
    expect(expandHome('~/Developer/x', home)).toBe('/Users/alice/Developer/x')
    expect(expandHome('/tmp/x', home)).toBe('/tmp/x')
    expect(displayPath('/Users/alice/Developer/x', home)).toBe('~/Developer/x')
    expect(displayPath('/Users/alice', home)).toBe('~')
    expect(displayPath('/Users/alicex/y', home)).toBe('/Users/alicex/y')
  })

  it('canonicalizes trailing slashes, ~ and unicode', () => {
    expect(canonicalizePath('~/Developer/x/', home)).toBe('/Users/alice/Developer/x')
    expect(canonicalizePath('/a/b/../c')).toBe('/a/c')
    expect(canonicalizePath('/a/e\u0301')).toBe('/a/\u00e9')
    expect(canonicalizePath('/')).toBe('/')
  })

  it('compares paths structurally', () => {
    expect(pathsEqual('/a/b/', '/a/b')).toBe(true)
    expect(isPathWithin('/a/b', '/a/b')).toBe(true)
    expect(isPathWithin('/a/b', '/a/b/c/d')).toBe(true)
    expect(isPathWithin('/a/b', '/a/bc')).toBe(false)
    expect(isPathWithin('/a/b', '/a')).toBe(false)
    expect(relativeWithin('/a/b', '/a/b/c/d')).toBe(path.join('c', 'd'))
    expect(relativeWithin('/a/b', '/x')).toBeNull()
  })

  it('safeJoin rejects escapes', () => {
    expect(safeJoin('/root', 'a/b')).toBe('/root/a/b')
    expect(() => safeJoin('/root', '../x')).toThrow()
    expect(() => safeJoin('/root', '/abs')).toThrow()
    expect(() => safeJoin('/root', 'a/../../x')).toThrow()
    expect(() => safeJoin('/root', 'a\0b')).toThrow()
  })

  it('archive path safety', () => {
    expect(isSafeArchivePath('projects/x/file.txt')).toBe(true)
    expect(isSafeArchivePath('../x')).toBe(false)
    expect(isSafeArchivePath('a/../b')).toBe(false)
    expect(isSafeArchivePath('/abs')).toBe(false)
    expect(isSafeArchivePath('C:/x')).toBe(false)
    expect(isSafeArchivePath('a//b')).toBe(false)
    expect(isSafeArchivePath('a/./b')).toBe(false)
    expect(isSafeArchivePath('')).toBe(false)
    expect(toPosix(path.join('a', 'b'))).toBe('a/b')
  })

  it('uses the real home by default', () => {
    expect(expandHome('~')).toBe(os.homedir())
  })
})
