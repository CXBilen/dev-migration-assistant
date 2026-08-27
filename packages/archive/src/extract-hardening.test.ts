/**
 * Hostile archives built in-test with raw tar headers and the low-level encrypt stream.
 * Every case must be rejected with a stable code, nothing may be written outside the destination,
 * and the destination must be left empty (or removed when we created it).
 */
import { gzipSync } from 'node:zlib'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ErrorCode } from '@devmig/model'
import { extractDevBackup } from './extract'
import { inspectDevBackup } from './inspect'
import {
  PASSWORD,
  buildRawTar,
  encryptRawPayload,
  expectCode,
  hostileTar,
  makeManifest,
  makeTempDir,
  readTree,
  removeTempDir,
  sha256Hex,
  type RawTarEntry,
} from './test-helpers'
import type { ExtractionLimits } from './types'
import { verifyDevBackup } from './verify'

describe('hardened extraction', () => {
  let tmp: string
  let dest: string
  let backup: string
  const manifest = makeManifest()

  beforeEach(async () => {
    tmp = await makeTempDir()
    dest = path.join(tmp, 'dest')
    backup = path.join(tmp, 'hostile.devbackup')
    await fs.mkdir(dest)
  })
  afterEach(async () => {
    await removeTempDir(tmp)
  })

  async function expectRejected(
    payload: Buffer,
    code: ErrorCode,
    opts: { limits?: Partial<ExtractionLimits>; backupId?: string } = {},
  ): Promise<void> {
    await encryptRawPayload(backup, payload, { backupId: opts.backupId })
    const before = await readTree(tmp)
    await expectCode(
      extractDevBackup({
        path: backup,
        password: PASSWORD,
        destinationDir: dest,
        limits: opts.limits,
      }),
      code,
    )
    const after = await readTree(tmp)
    expect(await fs.readdir(dest), 'destination must be empty after rejection').toEqual([])
    expect([...after.files.keys()], 'nothing may be written outside the destination').toEqual([
      ...before.files.keys(),
    ])
    expect(after.dirs).toEqual(before.dirs)
    expect(after.symlinks).toEqual([])
    await expectCode(
      verifyDevBackup({ path: backup, password: PASSWORD, limits: opts.limits }),
      code,
    )
  }

  const evil: {
    name: string
    entry: RawTarEntry
    code: ErrorCode
    limits?: Partial<ExtractionLimits>
  }[] = [
    {
      name: 'parent traversal',
      entry: { path: '../evil.txt', body: 'evil' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    {
      name: 'absolute path',
      entry: { path: '/abs.txt', body: 'evil' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    {
      name: 'drive letter',
      entry: { path: 'C:evil.txt', body: 'evil' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    {
      name: 'embedded ..',
      entry: { path: 'a/../evil.txt', body: 'evil' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    {
      name: 'embedded .',
      entry: { path: 'a/./b.txt', body: 'evil' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    {
      name: 'backslash',
      entry: { path: 'a\\b.txt', body: 'evil' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    {
      name: 'symlink',
      entry: { path: 'link', type: 'SymbolicLink', linkpath: '/etc/passwd' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    {
      name: 'hardlink',
      entry: { path: 'hard', type: 'Link', linkpath: 'manifest.json' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    { name: 'fifo', entry: { path: 'fifo', type: 'FIFO' }, code: 'ARCHIVE_ENTRY_REJECTED' },
    {
      name: 'char device',
      entry: { path: 'dev', type: 'CharacterDevice' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    // node-tar's Header forces size 0 for directories, so the body block parses as a broken header.
    {
      name: 'directory with body',
      entry: { path: 'dir', type: 'Directory', body: 'x' },
      code: 'ARCHIVE_INVALID',
    },
    {
      name: 'reserved temp suffix',
      entry: { path: 'x.devmig-partial', body: 'x' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    {
      name: 'second manifest',
      entry: { path: 'manifest.json', body: '{}' },
      code: 'ARCHIVE_ENTRY_REJECTED',
    },
    {
      name: 'oversized declared size',
      entry: { path: 'huge.bin', size: 100 * 1024 * 1024, body: 'tiny' },
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      limits: { maxEntryBytes: 1024 * 1024 },
    },
    {
      name: 'declared size larger than body',
      entry: { path: 'short.bin', size: 5000, body: 'tiny' },
      code: 'ARCHIVE_INVALID',
    },
    {
      name: 'too deep',
      entry: { path: 'a/b/c/d/e.txt', body: 'x' },
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      limits: { maxDepth: 3 },
    },
    {
      name: 'too long',
      entry: { path: `${'p'.repeat(90)}.txt`, body: 'x' },
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      limits: { maxPathLength: 64 },
    },
  ]
  for (const c of evil) {
    it(`rejects ${c.name}`, async () => {
      await expectRejected(hostileTar(manifest, [c.entry]), c.code, { limits: c.limits })
    })
  }

  it('rejects duplicate, case-colliding and file/directory-conflicting paths', async () => {
    await expectRejected(
      hostileTar(manifest, [
        { path: 'dup.txt', body: 'a' },
        { path: 'dup.txt', body: 'b' },
      ]),
      'ARCHIVE_ENTRY_REJECTED',
    )
    await expectRejected(
      hostileTar(manifest, [
        { path: 'Dup.txt', body: 'a' },
        { path: 'dup.txt', body: 'b' },
      ]),
      'ARCHIVE_ENTRY_REJECTED',
    )
    await expectRejected(
      hostileTar(manifest, [
        { path: 'f', body: 'a' },
        { path: 'f/x', body: 'b' },
      ]),
      'ARCHIVE_ENTRY_REJECTED',
    )
    await expectRejected(
      hostileTar(manifest, [
        { path: 'd', type: 'Directory' },
        { path: 'd', body: 'b' },
      ]),
      'ARCHIVE_ENTRY_REJECTED',
    )
    await expectRejected(
      hostileTar(manifest, [
        { path: 'é.txt', body: 'a' },
        { path: 'é.txt', body: 'b' },
      ]),
      'ARCHIVE_ENTRY_REJECTED',
    )
  })

  it('enforces entry and byte limits on hostile input', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, body: 'x' }))
    await expectRejected(hostileTar(manifest, many), 'ARCHIVE_LIMIT_EXCEEDED', {
      limits: { maxEntries: 4 },
    })
    await expectRejected(
      hostileTar(manifest, [{ path: 'a.bin', body: Buffer.alloc(3000) }]),
      'ARCHIVE_LIMIT_EXCEEDED',
      {
        limits: { maxTotalBytes: 2048 },
      },
    )
  })

  it('requires manifest.json first, valid, matching the header, and checksums.json last', async () => {
    const manifestBody = Buffer.from(JSON.stringify(manifest))
    await expectRejected(
      buildRawTar([
        { path: 'other.txt', body: 'x' },
        { path: 'manifest.json', body: manifestBody },
      ]),
      'ARCHIVE_INVALID',
    )
    await expectRejected(
      buildRawTar([{ path: 'manifest.json', type: 'Directory' }]),
      'ARCHIVE_INVALID',
    )
    await expectRejected(hostileTar({ ...manifest, id: 'someone-else' }, []), 'ARCHIVE_INVALID')
    await expectRejected(hostileTar(manifest, []), 'ARCHIVE_INVALID', {
      backupId: 'different-header-id',
    })
    await expectRejected(
      hostileTar({ ...manifest, formatVersion: 2 }, []),
      'ARCHIVE_UNSUPPORTED_VERSION',
    )
    await expectRejected(
      buildRawTar([
        { path: 'manifest.json', body: 'not json' },
        { path: 'checksums.json', body: '{}' },
      ]),
      'MANIFEST_INVALID',
    )
    await expectRejected(
      buildRawTar([
        { path: 'manifest.json', body: JSON.stringify({ format: 'devbackup' }) },
        { path: 'checksums.json', body: '{}' },
      ]),
      'MANIFEST_INVALID',
    )
    // entries after checksums.json, or no checksums.json at all
    const withTrailing = Buffer.concat([
      hostileTar(manifest, []).subarray(0, -1024),
      buildRawTar([{ path: 'late.txt', body: 'x' }]),
    ])
    await expectRejected(withTrailing, 'ARCHIVE_INVALID')
    await expectRejected(
      buildRawTar([{ path: 'manifest.json', body: manifestBody }]),
      'ARCHIVE_INVALID',
    )
    await expectRejected(
      buildRawTar([{ path: 'manifest.json', body: manifestBody }], { omitEnd: true }),
      'ARCHIVE_INVALID',
    )
    // manifest.json larger than the hard cap is refused before its body is read
    await expectRejected(
      buildRawTar([{ path: 'manifest.json', size: 65 * 1024 * 1024, body: 'x' }]),
      'ARCHIVE_LIMIT_EXCEEDED',
    )
  })

  it('rejects a compressed payload (no gzip sniffing) and a payload that is not tar', async () => {
    await expectRejected(gzipSync(hostileTar(manifest, [])), 'ARCHIVE_INVALID')
    await expectRejected(Buffer.from('definitely not a tar stream'), 'ARCHIVE_INVALID')
    await expectRejected(Buffer.alloc(0), 'ARCHIVE_INVALID')
  })

  it('checksums.json must describe exactly the extracted files', async () => {
    // an unlisted extra file
    await expectRejected(
      hostileTar(manifest, [{ path: 'extra.txt', body: 'x' }]),
      'ARCHIVE_INVALID',
    )
    // a listed file that is missing from the archive
    const manifestBody = Buffer.from(JSON.stringify(manifest))
    const missing = buildRawTar([
      { path: 'manifest.json', body: manifestBody },
      {
        path: 'checksums.json',
        body: JSON.stringify({
          algorithm: 'sha256',
          entries: [
            { path: 'gone.txt', sha256: 'a'.repeat(64), sizeBytes: 1 },
            {
              path: 'manifest.json',
              sha256: sha256Hex(manifestBody),
              sizeBytes: manifestBody.length,
            },
          ],
        }),
      },
    ])
    await expectRejected(missing, 'INTEGRITY_MISMATCH')
    // a listed file whose digest is wrong
    const wrong = hostileTar(manifest, [], {
      extraChecksums: [{ path: 'data.txt', body: 'right' }],
    })
      .toString('latin1')
      .replace('right', 'wrong')
    await expectRejected(Buffer.from(wrong, 'latin1'), 'INTEGRITY_MISMATCH')
    // malformed checksums.json
    await expectRejected(
      buildRawTar([
        { path: 'manifest.json', body: manifestBody },
        { path: 'checksums.json', body: 'nope' },
      ]),
      'ARCHIVE_INVALID',
    )
    await expectRejected(
      buildRawTar([
        { path: 'manifest.json', body: manifestBody },
        {
          path: 'checksums.json',
          body: JSON.stringify({
            algorithm: 'sha256',
            entries: [{ path: '../x', sha256: 'a'.repeat(64), sizeBytes: 1 }],
          }),
        },
      ]),
      'ARCHIVE_INVALID',
    )
  })

  it('accepts a benign raw archive (control) and inspect only needs the first entry', async () => {
    const payload = hostileTar(
      manifest,
      [
        { path: 'data', type: 'Directory' },
        { path: 'data/file.txt', body: 'hello' },
      ],
      {
        extraChecksums: [{ path: 'data/file.txt', body: 'hello' }],
      },
    )
    // hostileTar places extraChecksums entries right after the manifest; rebuild in sorted order.
    const ordered = buildRawTar([
      { path: 'manifest.json', body: Buffer.from(JSON.stringify(manifest)) },
      { path: 'data', type: 'Directory' },
      { path: 'data/file.txt', body: 'hello' },
      {
        path: 'checksums.json',
        body: JSON.stringify({
          algorithm: 'sha256',
          entries: [
            { path: 'data/file.txt', sha256: sha256Hex('hello'), sizeBytes: 5 },
            {
              path: 'manifest.json',
              sha256: sha256Hex(JSON.stringify(manifest)),
              sizeBytes: Buffer.byteLength(JSON.stringify(manifest)),
            },
          ],
        }),
      },
    ])
    expect(payload.length).toBeGreaterThan(0)
    await encryptRawPayload(backup, ordered)
    const result = await extractDevBackup({
      path: backup,
      password: PASSWORD,
      destinationDir: dest,
    })
    expect(result.entries).toBe(4)
    expect(await fs.readFile(path.join(dest, 'data', 'file.txt'), 'utf8')).toBe('hello')
    const verified = await verifyDevBackup({ path: backup, password: PASSWORD })
    expect(verified.ok).toBe(true)
    const inspected = await inspectDevBackup({ path: backup, password: PASSWORD })
    expect(inspected.manifest.id).toBe(manifest.id)
    // inspect tolerates hostile entries after the manifest (it never extracts), extract does not
    await encryptRawPayload(backup, hostileTar(manifest, [{ path: '../evil.txt', body: 'evil' }]))
    expect((await inspectDevBackup({ path: backup, password: PASSWORD })).manifest.id).toBe(
      manifest.id,
    )
    await expectCode(inspectDevBackup({ path: backup, password: 'nope' }), 'ARCHIVE_AUTH_FAILED')
  })
})
