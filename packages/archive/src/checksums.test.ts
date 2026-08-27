import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeChecksums,
  parseChecksums,
  verifyChecksumsAgainstDir,
  writeChecksumsFile,
} from './checksums'
import { expectCode, makeTempDir, removeTempDir, sha256Hex } from './test-helpers'

describe('checksums', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await makeTempDir()
    await fs.mkdir(path.join(tmp, 'b', 'deep'), { recursive: true })
    await fs.mkdir(path.join(tmp, 'a-dir'), { recursive: true })
    await fs.writeFile(path.join(tmp, 'manifest.json'), '{}')
    await fs.writeFile(path.join(tmp, 'b', 'deep', 'x.txt'), 'xx')
    await fs.writeFile(path.join(tmp, 'b', 'y.txt'), 'y')
    await fs.writeFile(path.join(tmp, 'a-dir', 'z.txt'), '')
    await fs.writeFile(path.join(tmp, 'checksums.json'), 'stale')
    await fs.symlink('manifest.json', path.join(tmp, 'link'))
  })
  afterEach(async () => {
    await removeTempDir(tmp)
  })

  it('lists regular files sorted by UTF-8 bytes, excluding checksums.json and symlinks', async () => {
    const result = await computeChecksums(tmp)
    expect(result.algorithm).toBe('sha256')
    expect(result.entries.map((e) => e.path)).toEqual([
      'a-dir/z.txt',
      'b/deep/x.txt',
      'b/y.txt',
      'manifest.json',
    ])
    expect(result.entries.find((e) => e.path === 'b/deep/x.txt')).toEqual({
      path: 'b/deep/x.txt',
      sha256: sha256Hex('xx'),
      sizeBytes: 2,
    })
    const excluded = await computeChecksums(tmp, { exclude: ['manifest.json'] })
    expect(excluded.entries.map((e) => e.path)).not.toContain('manifest.json')
  })

  it('writes checksums.json atomically and never lists itself', async () => {
    const written = await writeChecksumsFile(tmp)
    const onDisk = parseChecksums(await fs.readFile(path.join(tmp, 'checksums.json')))
    expect(onDisk).toEqual(written)
    expect(onDisk.entries.some((e) => e.path === 'checksums.json')).toBe(false)
    expect((await fs.readdir(tmp)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('parseChecksums rejects malformed, unsafe, duplicate and self-listing content', () => {
    expect(() => parseChecksums('nope')).toThrow(/valid JSON/)
    expect(() => parseChecksums('{"algorithm":"md5","entries":[]}')).toThrow(/malformed/)
    const entry = (p: string): string =>
      JSON.stringify({
        algorithm: 'sha256',
        entries: [{ path: p, sha256: 'a'.repeat(64), sizeBytes: 1 }],
      })
    expect(() => parseChecksums(entry('../x'))).toThrow(/unsafe/)
    expect(() => parseChecksums(entry('/x'))).toThrow(/unsafe/)
    expect(() => parseChecksums(entry('checksums.json'))).toThrow(/itself/)
    const dup = JSON.stringify({
      algorithm: 'sha256',
      entries: [
        { path: 'x', sha256: 'a'.repeat(64), sizeBytes: 1 },
        { path: 'x', sha256: 'a'.repeat(64), sizeBytes: 1 },
      ],
    })
    expect(() => parseChecksums(dup)).toThrow(/twice/)
    expect(() => parseChecksums(entry('ok').replace('a'.repeat(64), 'Z'.repeat(64)))).toThrow()
  })

  it('verifyChecksumsAgainstDir detects extra, missing and modified files', async () => {
    await fs.unlink(path.join(tmp, 'link'))
    const checksums = await writeChecksumsFile(tmp)
    await expect(verifyChecksumsAgainstDir(tmp, checksums)).resolves.toEqual({ files: 4, bytes: 5 })
    await fs.writeFile(path.join(tmp, 'extra.txt'), 'e')
    await expectCode(verifyChecksumsAgainstDir(tmp, checksums), 'ARCHIVE_INVALID')
    await fs.unlink(path.join(tmp, 'extra.txt'))
    await fs.writeFile(path.join(tmp, 'b', 'y.txt'), 'Y')
    await expectCode(verifyChecksumsAgainstDir(tmp, checksums), 'INTEGRITY_MISMATCH')
    await fs.writeFile(path.join(tmp, 'b', 'y.txt'), 'yy')
    await expectCode(verifyChecksumsAgainstDir(tmp, checksums), 'INTEGRITY_MISMATCH')
    await fs.unlink(path.join(tmp, 'b', 'y.txt'))
    const missing = await expectCode(
      verifyChecksumsAgainstDir(tmp, checksums),
      'INTEGRITY_MISMATCH',
    )
    expect(missing.details?.missing).toEqual(['b/y.txt'])
  })

  it('honours cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expectCode(computeChecksums(tmp, { signal: controller.signal }), 'CANCELLED')
  })
})
