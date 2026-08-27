import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMigrationError } from '@devmig/shared'
import {
  assertSafeFixtureRoot,
  makeTempRoot,
  makeTreeWritable,
  removeTempTree,
  withTempRoot,
} from './temp'

describe('makeTempRoot', () => {
  it('creates a private directory under os.tmpdir() and removes it on cleanup', async () => {
    const tmp = await makeTempRoot('devmig-temp-test-')
    const tmpDir = await fs.realpath(os.tmpdir())
    expect(tmp.root.startsWith(tmpDir + path.sep)).toBe(true)
    expect(path.basename(tmp.root).startsWith('devmig-temp-test-')).toBe(true)
    const st = await fs.stat(tmp.root)
    expect(st.isDirectory()).toBe(true)
    expect(st.mode & 0o777).toBe(0o700)
    await tmp.cleanup()
    await expect(fs.stat(tmp.root)).rejects.toMatchObject({ code: 'ENOENT' })
    // idempotent
    await expect(tmp.cleanup()).resolves.toBeUndefined()
  })

  it('removes read-only files and directories (git object style) on cleanup', async () => {
    const tmp = await makeTempRoot()
    const dir = path.join(tmp.root, 'objects', 'ab')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'cdef')
    await fs.writeFile(file, 'blob')
    await fs.chmod(file, 0o444)
    await fs.chmod(dir, 0o555)
    await tmp.cleanup()
    await expect(fs.stat(tmp.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects prefixes with path separators', async () => {
    await expect(makeTempRoot('../evil')).rejects.toSatisfy(
      (e: unknown) => isMigrationError(e) && e.code === 'INVALID_INPUT',
    )
  })
})

describe('withTempRoot', () => {
  it('runs the callback with a fresh root and cleans up even when it throws', async () => {
    let captured = ''
    await expect(
      withTempRoot(async (root) => {
        captured = root
        await fs.writeFile(path.join(root, 'x.txt'), 'x')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(captured).not.toBe('')
    await expect(fs.stat(captured)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns the callback result', async () => {
    await expect(
      withTempRoot((root) => Promise.resolve(path.basename(root).length > 0)),
    ).resolves.toBe(true)
  })
})

describe('removeTempTree', () => {
  it('refuses to remove anything outside os.tmpdir()', async () => {
    // The guard runs before any filesystem mutation; the home directory is never touched.
    await expect(removeTempTree(os.homedir())).rejects.toSatisfy(
      (e: unknown) => isMigrationError(e) && e.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
    )
    await expect(removeTempTree(os.tmpdir())).rejects.toSatisfy(
      (e: unknown) => isMigrationError(e) && e.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
    )
    expect(await fs.stat(os.homedir()).then((s) => s.isDirectory())).toBe(true)
  })

  it('ignores missing targets', async () => {
    await expect(
      removeTempTree(path.join(os.tmpdir(), 'devmig-does-not-exist-xyz')),
    ).resolves.toBeUndefined()
  })
})

describe('makeTreeWritable', () => {
  it('adds owner rwx to directories and rw to files without following symlinks', async () => {
    await withTempRoot(async (root) => {
      const dir = path.join(root, 'ro')
      await fs.mkdir(dir)
      const file = path.join(dir, 'f')
      await fs.writeFile(file, '1')
      await fs.chmod(file, 0o400)
      await fs.chmod(dir, 0o500)
      await makeTreeWritable(root)
      expect((await fs.stat(dir)).mode & 0o700).toBe(0o700)
      expect((await fs.stat(file)).mode & 0o600).toBe(0o600)
    })
  })
})

describe('assertSafeFixtureRoot', () => {
  const home = os.homedir()
  it.each([
    ['/', 'root'],
    [home, 'home'],
    [path.join(home, '.claude'), 'real claude dir'],
    [path.join(home, '.claude', 'projects'), 'inside real claude dir'],
    [path.join(home, '.ssh'), 'ssh'],
    [path.join(home, 'Library', 'Application Support'), 'Library'],
    [path.join(home, 'Documents', 'GitHub'), 'projects dir'],
    [path.join(home, 'Documents', 'GitHub', 'some-repo'), 'a real project'],
    [path.join(home, '.claude.json'), 'claude.json'],
    ['relative/path', 'relative'],
  ])('rejects %s (%s)', (p) => {
    expect(() => assertSafeFixtureRoot(p)).toThrow()
  })

  it('accepts temp directories and returns the canonical path', async () => {
    await withTempRoot((root) => {
      expect(assertSafeFixtureRoot(`${root}/`)).toBe(root)
      expect(assertSafeFixtureRoot(path.join(root, 'Users', 'alice'))).toBe(
        path.join(root, 'Users', 'alice'),
      )
      return Promise.resolve()
    })
  })
})
