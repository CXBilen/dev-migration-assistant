import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Manifest } from '@devmig/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTempRoot, writeFiles, type TempRoot } from './engine-fixtures'
import { FakeArchiveAdapter } from './fake-archive-adapter'

function manifest(id = 'backup_1'): Manifest {
  return {
    format: 'devbackup',
    formatVersion: 1,
    id,
    label: 'test',
    createdAt: new Date().toISOString(),
    appVersion: '0.0.0',
    machine: {
      platform: 'darwin',
      arch: 'arm64',
      osVersion: null,
      machineLabel: null,
      homeDir: '/Users/old',
      userName: 'old',
      tools: [],
      capturedAt: new Date().toISOString(),
    },
    providers: {},
    projects: [],
    global: [],
    stats: {
      projectCount: 0,
      artifactCount: 0,
      payloadBytes: 0,
      claudeSessionCount: 0,
      worktreeCount: 0,
    },
    restoreHints: {},
  }
}

describe('FakeArchiveAdapter', () => {
  let tmp: TempRoot
  let source: string
  let out: string
  const adapter = new FakeArchiveAdapter()

  beforeEach(async () => {
    tmp = await makeTempRoot('devmig-fakearchive-')
    source = path.join(tmp.root, 'src')
    out = path.join(tmp.root, 'out.devbackup')
    await writeFiles(source, {
      'manifest.json': JSON.stringify(manifest()),
      'projects/p/a.txt': 'hello',
    })
    await adapter.writeChecksumsFile(source)
  })
  afterEach(async () => {
    await tmp.cleanup()
  })

  it('round-trips create → readHeader → inspect → verify → extract', async () => {
    const created = await adapter.createDevBackup({
      sourceDir: source,
      outputPath: out,
      password: 'pw123456',
      manifest: manifest(),
    })
    expect(created.entries).toBe(3)
    expect(await adapter.listEntries(out)).toEqual([
      'manifest.json',
      'projects/p/a.txt',
      'checksums.json',
    ])
    const header = await adapter.readDevBackupHeader(out)
    expect(header.supported).toBe(true)
    expect(header.header.backupId).toBe('backup_1')
    const inspected = await adapter.inspectDevBackup({ path: out, password: 'pw123456' })
    expect(inspected.manifest.id).toBe('backup_1')
    const verified = await adapter.verifyDevBackup({ path: out, password: 'pw123456' })
    expect(verified.ok).toBe(true)
    expect(verified.entries).toBe(3)
    const dest = path.join(tmp.root, 'extracted')
    const extracted = await adapter.extractDevBackup({
      path: out,
      password: 'pw123456',
      destinationDir: dest,
    })
    expect(extracted.checksumsVerified).toBe(true)
    expect(await fs.readFile(path.join(dest, 'projects/p/a.txt'), 'utf8')).toBe('hello')
  })

  it('fails with ARCHIVE_AUTH_FAILED on a wrong password before touching the payload', async () => {
    await adapter.createDevBackup({
      sourceDir: source,
      outputPath: out,
      password: 'pw123456',
      manifest: manifest(),
    })
    const dest = path.join(tmp.root, 'extracted')
    await expect(
      adapter.inspectDevBackup({ path: out, password: 'wrong-password' }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_AUTH_FAILED' })
    await expect(
      adapter.extractDevBackup({ path: out, password: 'wrong-password', destinationDir: dest }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_AUTH_FAILED' })
    await expect(fs.stat(path.join(dest, 'manifest.json'))).rejects.toThrow()
  })

  it('refuses to overwrite an existing output and requires manifest.json in the source', async () => {
    await fs.writeFile(out, 'existing')
    await expect(
      adapter.createDevBackup({
        sourceDir: source,
        outputPath: out,
        password: 'pw123456',
        manifest: manifest(),
      }),
    ).rejects.toThrow()
    await fs.rm(path.join(source, 'manifest.json'))
    await expect(
      adapter.createDevBackup({
        sourceDir: source,
        outputPath: path.join(tmp.root, 'o2'),
        password: 'pw123456',
        manifest: manifest(),
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_INVALID' })
  })

  it('rejects unsafe entries, detects tampering and honours limits on extraction', async () => {
    await adapter.createDevBackup({
      sourceDir: source,
      outputPath: out,
      password: 'pw123456',
      manifest: manifest(),
    })
    const raw = JSON.parse(await fs.readFile(out, 'utf8')) as {
      entries: { path: string; dataBase64: string }[]
    }
    const tampered = path.join(tmp.root, 'tampered.devbackup')
    const evil = structuredClone(raw)
    evil.entries.push({ ...evil.entries[1]!, path: '../escape.txt' })
    await fs.writeFile(tampered, JSON.stringify(evil))
    await expect(
      adapter.extractDevBackup({
        path: tampered,
        password: 'pw123456',
        destinationDir: path.join(tmp.root, 'x1'),
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_ENTRY_REJECTED' })

    const corrupt = structuredClone(raw)
    corrupt.entries[1]!.dataBase64 = Buffer.from('changed').toString('base64')
    await fs.writeFile(tampered, JSON.stringify(corrupt))
    await expect(
      adapter.verifyDevBackup({ path: tampered, password: 'pw123456' }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })

    await expect(
      adapter.extractDevBackup({
        path: out,
        password: 'pw123456',
        destinationDir: path.join(tmp.root, 'x2'),
        limits: { maxEntries: 1 },
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT_EXCEEDED' })
    await expect(
      adapter.extractDevBackup({
        path: out,
        password: 'pw123456',
        destinationDir: path.join(tmp.root, 'x3'),
        limits: { maxTotalBytes: 3 },
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT_EXCEEDED' })
  })

  it('patchManifest keeps checksums consistent', async () => {
    await adapter.createDevBackup({
      sourceDir: source,
      outputPath: out,
      password: 'pw123456',
      manifest: manifest(),
    })
    await adapter.patchManifest(out, (m) => ({ ...m, label: 'patched' }))
    const dest = path.join(tmp.root, 'extracted')
    const extracted = await adapter.extractDevBackup({
      path: out,
      password: 'pw123456',
      destinationDir: dest,
    })
    expect(extracted.manifest.label).toBe('patched')
    expect(extracted.checksumsVerified).toBe(true)
  })
})
