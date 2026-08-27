import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MigrationError } from './errors'
import { ScopedFs } from './scoped-fs'

let tmp: string
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-fs-')))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('ScopedFs', () => {
  it('writes inside roots and rejects outside', async () => {
    const root = path.join(tmp, 'root')
    const sfs = new ScopedFs([root])
    await sfs.writeFile(path.join(root, 'a/b.txt'), 'hi')
    expect(await sfs.readText(path.join(root, 'a/b.txt'))).toBe('hi')
    await expect(sfs.writeFile(path.join(tmp, 'outside.txt'), 'x')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ALLOWED_ROOT',
    })
    await expect(sfs.writeFile(path.join(root, '../outside.txt'), 'x')).rejects.toBeInstanceOf(
      MigrationError,
    )
    expect(await sfs.exists(path.join(tmp, 'outside.txt'))).toBe(false)
  })

  it('allows creating a root that does not exist yet', async () => {
    const root = path.join(tmp, 'new/project')
    const sfs = new ScopedFs([root])
    await sfs.mkdir(root)
    await sfs.writeFileAtomic(path.join(root, 'file.txt'), 'data', 0o600)
    const stat = await fs.stat(path.join(root, 'file.txt'))
    expect(stat.mode & 0o777).toBe(0o600)
    expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('data')
  })

  it('rejects symlink escapes inside a root', async () => {
    const root = path.join(tmp, 'root')
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, path.join(root, 'link'))
    const sfs = new ScopedFs([root])
    await expect(sfs.writeFile(path.join(root, 'link/evil.txt'), 'x')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ALLOWED_ROOT',
    })
    expect(await sfs.exists(path.join(outside, 'evil.txt'))).toBe(false)
  })

  it('accepts a root reached through a symlinked ancestor', async () => {
    const real = path.join(tmp, 'real')
    await fs.mkdir(real, { recursive: true })
    const link = path.join(tmp, 'link')
    await fs.symlink(real, link)
    const sfs = new ScopedFs([link])
    await sfs.writeFile(path.join(link, 'ok.txt'), 'x')
    expect(await fs.readFile(path.join(real, 'ok.txt'), 'utf8')).toBe('x')
  })

  it('copyFileAtomic streams and preserves the mode; copyDir skips symlinks', async () => {
    const root = path.join(tmp, 'root')
    const src = path.join(tmp, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'exec.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await fs.writeFile(path.join(src, 'plain.txt'), 'plain')
    await fs.symlink(path.join(tmp, 'nowhere'), path.join(src, 'dangling'))
    const sfs = new ScopedFs([root])
    await sfs.copyFileAtomic(path.join(src, 'exec.sh'), path.join(root, 'bin/exec.sh'))
    expect((await fs.stat(path.join(root, 'bin/exec.sh'))).mode & 0o777).toBe(0o755)
    const stats = await sfs.copyDir(src, path.join(root, 'copy'))
    expect(stats.files).toBe(2)
    expect(stats.skippedSymlinks).toEqual(['dangling'])
    const leftovers = (await fs.readdir(path.join(root, 'bin'))).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('withRoots extends and file-level roots allow exactly that file', async () => {
    const file = path.join(tmp, 'claude.json')
    const sfs = new ScopedFs([path.join(tmp, 'other')]).withRoots([file])
    await sfs.writeFileAtomic(file, '{}')
    await expect(sfs.writeFile(path.join(tmp, 'claude.json.bak'), 'x')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ALLOWED_ROOT',
    })
    expect(sfs.isAllowed(file)).toBe(true)
  })
})
