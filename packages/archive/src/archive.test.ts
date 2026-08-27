import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDevBackup } from './create'
import { extractDevBackup } from './extract'
import { readDevBackupHeader } from './header'
import { inspectDevBackup } from './inspect'
import { deriveKeyFromPassword } from './kdf'
import { planPayload } from './pack'
import {
  FAST_KDF,
  PASSWORD,
  createFixtureBackup,
  expectCode,
  fastCreateOptions,
  flipByte,
  makeManifest,
  makeTempDir,
  readLayout,
  readTree,
  removeTempDir,
  setFormatVersion,
  swapChunks,
  tamperHeaderField,
  truncateFile,
} from './test-helpers'
import type { ArchiveProgress } from './types'
import { verifyDevBackup } from './verify'
import { writeChecksumsFile } from './checksums'

describe('.devbackup round trip', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await makeTempDir()
  })
  afterEach(async () => {
    await removeTempDir(tmp)
  })

  it('creates, reads the header, inspects, verifies and extracts byte-identically', async () => {
    const fixture = await createFixtureBackup(tmp)
    const { outputPath, result, manifest } = fixture
    expect(result.outputPath).toBe(outputPath)
    expect(result.sizeBytes).toBe((await fs.stat(outputPath)).size)
    const stagingTree = await readTree(path.join(tmp, 'staging'))
    expect(result.entries).toBe(fixture.files.size + stagingTree.dirs.length)
    expect(result.payloadBytes).toBeGreaterThan(3 * 1024 * 1024)
    expect(result.checksums.entries.map((e) => e.path)).toContain('manifest.json')
    expect(result.warnings).toEqual([])
    expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(path.dirname(outputPath))).toEqual(['test.devbackup'])

    const header = await readDevBackupHeader(outputPath)
    expect(header.supported).toBe(true)
    expect(header.header.backupId).toBe(manifest.id)
    expect(header.header.kdf).toMatchObject(FAST_KDF)
    expect(header.header.chunkSize).toBe(1024 * 1024)
    expect(Buffer.from(header.header.kdf.saltBase64, 'base64').length).toBe(16)

    const inspected = await inspectDevBackup({ path: outputPath, password: PASSWORD })
    expect(inspected.manifest).toEqual(manifest)
    expect(inspected.header).toEqual(header.header)

    const events: ArchiveProgress[] = []
    const verified = await verifyDevBackup({
      path: outputPath,
      password: PASSWORD,
      onProgress: (p) => events.push(p),
    })
    expect(verified.ok).toBe(true)
    expect(verified.manifest.id).toBe(manifest.id)
    expect(verified.entries).toBe(result.entries)
    expect(events.length).toBeGreaterThan(0)
    expect(events.at(-1)?.totalBytes).toBeGreaterThan(0)

    const dest = path.join(tmp, 'extracted')
    const extracted = await extractDevBackup({
      path: outputPath,
      password: PASSWORD,
      destinationDir: dest,
    })
    expect(extracted.checksumsVerified).toBe(true)
    expect(extracted.entries).toBe(result.entries)
    expect((await fs.stat(dest)).mode & 0o777).toBe(0o700)
    const tree = await readTree(dest)
    expect(tree.symlinks).toEqual([])
    expect([...tree.files.keys()].sort()).toEqual([...fixture.files.keys()].sort())
    for (const [rel, expected] of fixture.files) {
      expect(tree.files.get(rel)?.equals(expected), `content of ${rel}`).toBe(true)
    }
    expect(tree.dirs).toContain('projects/p1/claude-code/todos')
    expect(
      (await fs.stat(path.join(dest, 'projects/p1/git/hooks/pre-commit'))).mode & 0o111,
    ).not.toBe(0)
    expect((await fs.readdir(dest)).some((n) => n.includes('partial'))).toBe(false)
  })

  it('orders the payload deterministically: manifest first, checksums last, others sorted', async () => {
    const fixture = await createFixtureBackup(tmp)
    const plan = await planPayload(path.join(tmp, 'staging'))
    const paths = plan.entries.map((e) => e.path)
    expect(paths[0]).toBe('manifest.json')
    expect(paths.at(-1)).toBe('checksums.json')
    const middle = paths.slice(1, -1)
    expect(middle).toEqual(
      [...middle].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    )
    expect(paths.indexOf('projects')).toBeLessThan(paths.indexOf('projects/p1'))
    expect(plan.entries.length).toBe(fixture.result.entries)
  })

  it('inspect reads only a prefix of the file and extracts nothing', async () => {
    const fixture = await createFixtureBackup(tmp, {
      chunkSize: 64 * 1024,
      mutate: async (tree) => {
        await fs.writeFile(
          path.join(tree.root, 'projects/p1/git/big.bin'),
          randomBytes(6 * 1024 * 1024),
        )
        await writeChecksumsFile(tree.root)
      },
    })
    const before = await readTree(tmp)
    const inspected = await inspectDevBackup({ path: fixture.outputPath, password: PASSWORD })
    expect(inspected.manifest.id).toBe(fixture.manifest.id)
    expect(inspected.bytesRead).toBeGreaterThan(0)
    expect(inspected.bytesRead).toBeLessThan(inspected.sizeBytes / 2)
    const after = await readTree(tmp)
    expect([...after.files.keys()]).toEqual([...before.files.keys()])
    expect(after.dirs).toEqual(before.dirs)
  })

  it('fails fast on a wrong password, before touching the payload', async () => {
    const fixture = await createFixtureBackup(tmp)
    const header = await readDevBackupHeader(fixture.outputPath)
    const kdfStart = performance.now()
    await deriveKeyFromPassword('wrong password', header.header.kdf)
    const kdfMs = performance.now() - kdfStart
    const start = performance.now()
    const err = await expectCode(
      inspectDevBackup({ path: fixture.outputPath, password: 'wrong password' }),
      'ARCHIVE_AUTH_FAILED',
    )
    const elapsed = performance.now() - start
    expect(err.recoverable).toBe(true)
    expect(elapsed - kdfMs).toBeLessThan(200)
    await expectCode(
      verifyDevBackup({ path: fixture.outputPath, password: 'wrong password' }),
      'ARCHIVE_AUTH_FAILED',
    )
    const dest = path.join(tmp, 'dest')
    await expectCode(
      extractDevBackup({
        path: fixture.outputPath,
        password: 'wrong password',
        destinationDir: dest,
      }),
      'ARCHIVE_AUTH_FAILED',
    )
    await expect(fs.stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('normalises the password (NFC vs NFD input yield the same key)', async () => {
    const fixture = await createFixtureBackup(tmp, { password: 'pässwörd-ü' })
    const decomposed = 'pässwörd-ü'
    expect(decomposed).not.toBe('pässwörd-ü')
    const inspected = await inspectDevBackup({ path: fixture.outputPath, password: decomposed })
    expect(inspected.manifest.id).toBe(fixture.manifest.id)
  })

  describe('tamper detection', () => {
    it('header JSON: a changed non-KDF field breaks the AAD; broken syntax is ARCHIVE_INVALID; KDF field is AUTH_FAILED', async () => {
      const fixture = await createFixtureBackup(tmp)
      const pristine = await fs.readFile(fixture.outputPath)
      await tamperHeaderField(fixture.outputPath, 'createdAt')
      await expectCode(
        inspectDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
      await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )

      await fs.writeFile(fixture.outputPath, pristine)
      await flipByte(fixture.outputPath, 12) // the opening brace
      await expectCode(readDevBackupHeader(fixture.outputPath), 'ARCHIVE_INVALID')
      await expectCode(
        inspectDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'ARCHIVE_INVALID',
      )

      await fs.writeFile(fixture.outputPath, pristine)
      await tamperHeaderField(fixture.outputPath, 'saltBase64')
      await expectCode(
        inspectDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'ARCHIVE_AUTH_FAILED',
      )
    })

    it('a flipped ciphertext byte is INTEGRITY_MISMATCH at that chunk and leaves the destination empty', async () => {
      const fixture = await createFixtureBackup(tmp, { chunkSize: 64 * 1024 })
      const layout = await readLayout(fixture.outputPath)
      await flipByte(fixture.outputPath, layout.payloadOffset + layout.sealedChunkSize * 3 + 100)
      const err = await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
      expect(err.details?.chunkIndex).toBe(3)
      const dest = path.join(tmp, 'dest')
      await fs.mkdir(dest)
      await expectCode(
        extractDevBackup({ path: fixture.outputPath, password: PASSWORD, destinationDir: dest }),
        'INTEGRITY_MISMATCH',
      )
      expect(await fs.readdir(dest)).toEqual([])
    })

    it('truncation at a chunk boundary, mid-chunk, and inside the header', async () => {
      const fixture = await createFixtureBackup(tmp, { chunkSize: 64 * 1024 })
      const pristine = await fs.readFile(fixture.outputPath)
      const layout = await readLayout(fixture.outputPath)
      await truncateFile(fixture.outputPath, layout.payloadOffset + layout.sealedChunkSize * 10)
      await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
      await fs.writeFile(fixture.outputPath, pristine)
      await truncateFile(
        fixture.outputPath,
        layout.payloadOffset + layout.sealedChunkSize * 10 + 1234,
      )
      await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
      await fs.writeFile(fixture.outputPath, pristine)
      await truncateFile(fixture.outputPath, layout.sizeBytes - 1)
      await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
      await fs.writeFile(fixture.outputPath, pristine)
      await truncateFile(fixture.outputPath, layout.payloadOffset - 5)
      await expectCode(readDevBackupHeader(fixture.outputPath), 'ARCHIVE_INVALID')
      await fs.writeFile(fixture.outputPath, pristine)
      await truncateFile(fixture.outputPath, layout.payloadOffset)
      await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
    })

    it('swapped chunks and appended bytes', async () => {
      const fixture = await createFixtureBackup(tmp, { chunkSize: 64 * 1024 })
      const pristine = await fs.readFile(fixture.outputPath)
      await swapChunks(fixture.outputPath, 1, 2)
      const err = await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
      expect(err.details?.chunkIndex).toBe(1)
      await fs.writeFile(
        fixture.outputPath,
        Buffer.concat([pristine, Buffer.from('trailing junk')]),
      )
      await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
    })

    it('a newer format version is reported, not decrypted', async () => {
      const fixture = await createFixtureBackup(tmp)
      await setFormatVersion(fixture.outputPath, 2)
      const header = await readDevBackupHeader(fixture.outputPath)
      expect(header.supported).toBe(false)
      expect(header.header.formatVersion).toBe(2)
      await expectCode(
        inspectDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'ARCHIVE_UNSUPPORTED_VERSION',
      )
      await expectCode(
        extractDevBackup({
          path: fixture.outputPath,
          password: PASSWORD,
          destinationDir: path.join(tmp, 'd'),
        }),
        'ARCHIVE_UNSUPPORTED_VERSION',
      )
      await expect(fs.stat(path.join(tmp, 'd'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('rejects files that are not archives at all', async () => {
      const junk = path.join(tmp, 'junk.devbackup')
      await fs.writeFile(junk, randomBytes(10_000))
      await expectCode(inspectDevBackup({ path: junk, password: PASSWORD }), 'ARCHIVE_INVALID')
      await expectCode(
        inspectDevBackup({ path: path.join(tmp, 'nope'), password: PASSWORD }),
        'PATH_NOT_FOUND',
      )
    })
  })

  describe('checksums', () => {
    it('a file modified after checksums.json was written fails verify and extract', async () => {
      const fixture = await createFixtureBackup(tmp, {
        mutate: async (tree) => {
          // same size, different content, written after checksums.json
          await fs.writeFile(
            path.join(tree.root, 'global/claude-code/settings.json'),
            '{"theme":"DARK"}\n',
          )
        },
      })
      const err = await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
      expect(err.details?.path).toBe('global/claude-code/settings.json')
      const dest = path.join(tmp, 'dest')
      await expectCode(
        extractDevBackup({ path: fixture.outputPath, password: PASSWORD, destinationDir: dest }),
        'INTEGRITY_MISMATCH',
      )
      await expect(fs.stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
      const unchecked = await extractDevBackup({
        path: fixture.outputPath,
        password: PASSWORD,
        destinationDir: dest,
        verifyChecksums: false,
      })
      expect(unchecked.checksumsVerified).toBe(false)
    })

    it('re-packing an extracted tree with a tampered file (stale checksums.json) fails verification', async () => {
      const fixture = await createFixtureBackup(tmp)
      const dest = path.join(tmp, 'extracted')
      await extractDevBackup({ path: fixture.outputPath, password: PASSWORD, destinationDir: dest })
      const target = path.join(dest, 'projects/p1/claude-code/sessions/0a1b2c3d.jsonl')
      const original = await fs.readFile(target)
      original[10] = (original[10] as number) ^ 0x20
      await fs.writeFile(target, original)
      const repacked = path.join(tmp, 'repacked.devbackup')
      await createDevBackup(
        fastCreateOptions({
          sourceDir: dest,
          outputPath: repacked,
          password: PASSWORD,
          manifest: fixture.manifest,
        }),
      )
      await expectCode(
        verifyDevBackup({ path: repacked, password: PASSWORD }),
        'INTEGRITY_MISMATCH',
      )
      const fresh = await verifyDevBackup({ path: fixture.outputPath, password: PASSWORD })
      expect(fresh.ok).toBe(true)
    })
  })

  describe('limits', () => {
    it('enforces maxEntries, maxTotalBytes, maxEntryBytes and maxPathLength and cleans up', async () => {
      const fixture = await createFixtureBackup(tmp)
      const dest = path.join(tmp, 'dest')
      const cases = [
        { limits: { maxEntries: 3 } },
        { limits: { maxTotalBytes: 1024 } },
        { limits: { maxEntryBytes: 1024 * 1024 } },
        { limits: { maxPathLength: 12 } },
        { limits: { maxDepth: 2 } },
      ]
      for (const c of cases) {
        await expectCode(
          extractDevBackup({
            path: fixture.outputPath,
            password: PASSWORD,
            destinationDir: dest,
            ...c,
          }),
          'ARCHIVE_LIMIT_EXCEEDED',
        )
        await expect(fs.stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
        await expectCode(
          verifyDevBackup({ path: fixture.outputPath, password: PASSWORD, ...c }),
          'ARCHIVE_LIMIT_EXCEEDED',
        )
      }
    })
  })

  describe('destination handling', () => {
    it('refuses non-empty directories, files and symlinks; creates missing directories with 0700', async () => {
      const fixture = await createFixtureBackup(tmp)
      const busy = path.join(tmp, 'busy')
      await fs.mkdir(busy)
      await fs.writeFile(path.join(busy, 'keep.txt'), 'keep')
      await expectCode(
        extractDevBackup({ path: fixture.outputPath, password: PASSWORD, destinationDir: busy }),
        'RESTORE_DESTINATION_EXISTS',
      )
      expect(await fs.readFile(path.join(busy, 'keep.txt'), 'utf8')).toBe('keep')
      const file = path.join(tmp, 'file.txt')
      await fs.writeFile(file, 'x')
      await expectCode(
        extractDevBackup({ path: fixture.outputPath, password: PASSWORD, destinationDir: file }),
        'NOT_A_DIRECTORY',
      )
      const link = path.join(tmp, 'link')
      await fs.mkdir(path.join(tmp, 'real'))
      await fs.symlink(path.join(tmp, 'real'), link)
      await expectCode(
        extractDevBackup({ path: fixture.outputPath, password: PASSWORD, destinationDir: link }),
        'INVALID_INPUT',
      )
      const nested = path.join(tmp, 'new', 'nested', 'dest')
      await extractDevBackup({
        path: fixture.outputPath,
        password: PASSWORD,
        destinationDir: nested,
      })
      expect((await fs.stat(nested)).mode & 0o777).toBe(0o700)
    })
  })

  describe('cancellation', () => {
    it('abort mid-create leaves neither the output nor a partial file', async () => {
      const staging = path.join(tmp, 'staging')
      await fs.mkdir(staging)
      const manifest = makeManifest()
      await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest))
      await fs.writeFile(path.join(staging, 'big.bin'), randomBytes(2 * 1024 * 1024))
      await writeChecksumsFile(staging)
      const outputPath = path.join(tmp, 'aborted.devbackup')
      const controller = new AbortController()
      let progressCalls = 0
      await expectCode(
        createDevBackup(
          fastCreateOptions({
            sourceDir: staging,
            outputPath,
            password: PASSWORD,
            manifest,
            chunkSize: 64 * 1024,
            signal: controller.signal,
            onProgress: () => {
              progressCalls += 1
              controller.abort()
            },
          }),
        ),
        'CANCELLED',
      )
      expect(progressCalls).toBeGreaterThan(0)
      expect(await fs.readdir(tmp)).toEqual(['staging'])
    })

    it('abort mid-extract empties the destination', async () => {
      const fixture = await createFixtureBackup(tmp, { chunkSize: 64 * 1024 })
      const dest = path.join(tmp, 'dest')
      const controller = new AbortController()
      await expectCode(
        extractDevBackup({
          path: fixture.outputPath,
          password: PASSWORD,
          destinationDir: dest,
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
        'CANCELLED',
      )
      await expect(fs.stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
      const already = new AbortController()
      already.abort()
      await expectCode(
        verifyDevBackup({ path: fixture.outputPath, password: PASSWORD, signal: already.signal }),
        'CANCELLED',
      )
    })
  })

  describe('create validation', () => {
    it('rejects missing manifest.json, id mismatch, weak KDF override and empty password', async () => {
      const staging = path.join(tmp, 'staging')
      await fs.mkdir(staging)
      const manifest = makeManifest()
      const outputPath = path.join(tmp, 'x.devbackup')
      await expectCode(
        createDevBackup(
          fastCreateOptions({ sourceDir: staging, outputPath, password: PASSWORD, manifest }),
        ),
        'INVALID_INPUT',
      )
      await fs.writeFile(
        path.join(staging, 'manifest.json'),
        JSON.stringify({ ...manifest, id: 'other' }),
      )
      await expectCode(
        createDevBackup(
          fastCreateOptions({ sourceDir: staging, outputPath, password: PASSWORD, manifest }),
        ),
        'INVALID_INPUT',
      )
      await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest))
      await expectCode(
        createDevBackup({
          sourceDir: staging,
          outputPath,
          password: PASSWORD,
          manifest,
          kdf: { memoryKiB: 1024 },
        }),
        'INVALID_INPUT',
      )
      await expectCode(
        createDevBackup(
          fastCreateOptions({ sourceDir: staging, outputPath, password: '', manifest }),
        ),
        'INVALID_INPUT',
      )
      await expectCode(
        createDevBackup(
          fastCreateOptions({
            sourceDir: path.join(tmp, 'missing'),
            outputPath,
            password: PASSWORD,
            manifest,
          }),
        ),
        'PATH_NOT_FOUND',
      )
      await expectCode(
        createDevBackup(
          fastCreateOptions({
            sourceDir: staging,
            outputPath,
            password: PASSWORD,
            manifest: { ...manifest, format: 'nope' as 'devbackup' },
          }),
        ),
        'MANIFEST_INVALID',
      )
      expect(await fs.readdir(tmp)).toEqual(['staging'])
    })

    it('skips symlinks in the source tree and reports them', async () => {
      const fixture = await createFixtureBackup(tmp, {
        mutate: async (tree) => {
          await fs.symlink('manifest.json', path.join(tree.root, 'dangling-link'))
        },
      })
      expect(fixture.result.warnings).toEqual(['Skipped non-regular file: dangling-link'])
      const dest = path.join(tmp, 'dest')
      const tree = await readTree(
        (await extractDevBackup({
          path: fixture.outputPath,
          password: PASSWORD,
          destinationDir: dest,
        }),
        dest),
      )
      expect(tree.symlinks).toEqual([])
      expect(tree.files.has('dangling-link')).toBe(false)
    })
  })
})
