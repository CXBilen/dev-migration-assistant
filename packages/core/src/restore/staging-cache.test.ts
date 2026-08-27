import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Manifest } from '@devmig/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectingLogger,
  directJobContext,
  makeTempRoot,
  writeFiles,
  type TempRoot,
} from '../testing/engine-fixtures'
import { FakeArchiveAdapter } from '../testing/fake-archive-adapter'
import { StagingCache, freeSpaceBytes, stagingKeyFor } from './staging-cache'

function manifest(id: string, payloadBytes = 0): Manifest {
  return {
    format: 'devbackup',
    formatVersion: 1,
    id,
    label: 'test',
    createdAt: new Date().toISOString(),
    appVersion: '0',
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
      payloadBytes,
      claudeSessionCount: 0,
      worktreeCount: 0,
    },
    restoreHints: {},
  }
}

describe('StagingCache', () => {
  let tmp: TempRoot
  let backup: string
  const archive = new FakeArchiveAdapter()
  beforeEach(async () => {
    tmp = await makeTempRoot('devmig-staging-')
    const src = path.join(tmp.root, 'src')
    await writeFiles(src, {
      'manifest.json': JSON.stringify(manifest('b1')),
      'global/x/settings.json': '{}',
    })
    await archive.writeChecksumsFile(src)
    backup = path.join(tmp.root, 'b.devbackup')
    await archive.createDevBackup({
      sourceDir: src,
      outputPath: backup,
      password: 'pw123456',
      manifest: manifest('b1'),
    })
  })
  afterEach(async () => {
    await tmp.cleanup()
  })

  it('extracts once per backup file, re-authenticates on reuse and cleans up by refs', async () => {
    const { logger } = collectingLogger()
    const workDir = path.join(tmp.root, 'work')
    const cache = new StagingCache({ archive, workDir, logger })
    const job = directJobContext(logger)
    const first = await cache.acquire(backup, 'pw123456', job)
    expect(first.stagingDir.startsWith(workDir)).toBe(true)
    expect((await fs.stat(first.stagingDir)).mode & 0o777).toBe(0o700)
    expect(await fs.readFile(path.join(first.payloadRoot, 'global/x/settings.json'), 'utf8')).toBe(
      '{}',
    )
    expect(first.checksumsVerified).toBe(true)
    const extractCalls = archive.calls.filter((c) => c.op === 'extract').length

    const second = await cache.acquire(backup, 'pw123456', job)
    expect(second).toBe(first)
    expect(archive.calls.filter((c) => c.op === 'extract').length).toBe(extractCalls)
    await expect(cache.acquire(backup, 'wrong-password', job)).rejects.toMatchObject({
      code: 'ARCHIVE_AUTH_FAILED',
    })

    cache.retain(first.key, 'plan1')
    await cache.cleanup()
    expect(await fs.stat(first.payloadRoot)).toBeTruthy()
    cache.release(first.key, 'plan1')
    await cache.cleanup()
    await expect(fs.stat(first.stagingDir)).rejects.toThrow()
    expect(cache.keys()).toEqual([])

    // A new file with the same content but different mtime/size gets its own key.
    const { key } = await stagingKeyFor(backup)
    expect(key).toContain(backup)
  })

  it('re-extracts when the cached directory disappeared and disposes everything', async () => {
    const { logger } = collectingLogger()
    const cache = new StagingCache({ archive, workDir: path.join(tmp.root, 'work'), logger })
    const job = directJobContext(logger)
    const first = await cache.acquire(backup, 'pw123456', job)
    await fs.rm(first.stagingDir, { recursive: true, force: true })
    const second = await cache.acquire(backup, 'pw123456', job)
    expect(second.stagingDir).not.toBe(first.stagingDir)
    await cache.dispose()
    await expect(fs.stat(second.stagingDir)).rejects.toThrow()
  })

  it('refuses extraction when free space is insufficient', async () => {
    const { logger } = collectingLogger()
    const huge = manifest('b2', Number.MAX_SAFE_INTEGER)
    await archive.patchManifest(backup, () => huge)
    const cache = new StagingCache({ archive, workDir: path.join(tmp.root, 'work'), logger })
    await expect(cache.acquire(backup, 'pw123456', directJobContext(logger))).rejects.toMatchObject(
      { code: 'DISK_FULL' },
    )
    expect(await freeSpaceBytes(path.join(tmp.root, 'does', 'not', 'exist'))).toBeGreaterThan(0)
  })
})
