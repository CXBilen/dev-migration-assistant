import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeChecksumsForDir } from '../testing/fake-archive-adapter'
import { makeTempRoot, writeFiles, type TempRoot } from '../testing/engine-fixtures'
import {
  assertPayloadIntegrity,
  readChecksumsFile,
  verifyPayloadChecksums,
} from './integrity-verifier'

describe('integrity verifier', () => {
  let tmp: TempRoot
  let payload: string
  beforeEach(async () => {
    tmp = await makeTempRoot('devmig-integrity-')
    payload = path.join(tmp.root, 'payload')
    await writeFiles(payload, {
      'manifest.json': '{"id":"x"}',
      'projects/p1/files/a.txt': 'aaa',
      'projects/p1/files/nested/b.txt': 'bbb',
    })
    const checksums = await computeChecksumsForDir(payload)
    await fs.writeFile(path.join(payload, 'checksums.json'), JSON.stringify(checksums))
  })
  afterEach(async () => {
    await tmp.cleanup()
  })

  it('verifies an intact payload', async () => {
    const report = await verifyPayloadChecksums(payload)
    expect(report).toEqual({ ok: true, verified: 3, issues: [] })
    await expect(assertPayloadIntegrity(payload)).resolves.toMatchObject({ ok: true })
    expect((await readChecksumsFile(payload)).entries.map((e) => e.path)).toEqual([
      'manifest.json',
      'projects/p1/files/a.txt',
      'projects/p1/files/nested/b.txt',
    ])
  })

  it('reports mismatches, size changes, missing and extra files', async () => {
    await fs.writeFile(path.join(payload, 'projects/p1/files/a.txt'), 'AAA')
    await fs.writeFile(path.join(payload, 'projects/p1/files/nested/b.txt'), 'bbbb')
    await fs.rm(path.join(payload, 'manifest.json'))
    await fs.writeFile(path.join(payload, 'extra.txt'), 'x')
    const report = await verifyPayloadChecksums(payload)
    expect(report.ok).toBe(false)
    const kinds = new Map(report.issues.map((i) => [i.path, i.kind]))
    expect(kinds.get('projects/p1/files/a.txt')).toBe('mismatch')
    expect(kinds.get('projects/p1/files/nested/b.txt')).toBe('size')
    expect(kinds.get('manifest.json')).toBe('missing')
    expect(kinds.get('extra.txt')).toBe('extra')
    await expect(assertPayloadIntegrity(payload)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
    })
    const lenient = await verifyPayloadChecksums(payload, { reportExtraFiles: false })
    expect(lenient.issues.some((i) => i.kind === 'extra')).toBe(false)
  })

  it('rejects a missing or malformed checksums.json with ARCHIVE_INVALID', async () => {
    await fs.rm(path.join(payload, 'checksums.json'))
    await expect(readChecksumsFile(payload)).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' })
    await fs.writeFile(path.join(payload, 'checksums.json'), '{not json')
    await expect(readChecksumsFile(payload)).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' })
    await fs.writeFile(path.join(payload, 'checksums.json'), '{"algorithm":"md5","entries":[]}')
    await expect(readChecksumsFile(payload)).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' })
  })

  it('honours cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(verifyPayloadChecksums(payload, { signal: controller.signal })).rejects.toThrow()
  })
})
