/**
 * Streaming guarantee: a 64 MiB payload must round-trip with bounded memory. Runs in the
 * integration project (forked worker) so the RSS measurement is not polluted by other suites.
 */
import { randomBytes } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { hashFile } from '@devmig/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeChecksumsFile } from './checksums'
import { createDevBackup } from './create'
import { extractDevBackup } from './extract'
import {
  PASSWORD,
  fastCreateOptions,
  makeManifest,
  makeTempDir,
  removeTempDir,
} from './test-helpers'
import { verifyDevBackup } from './verify'

const SIZE = 64 * 1024 * 1024

function* randomChunks(total: number): Generator<Buffer> {
  for (let written = 0; written < total; written += 1024 * 1024) yield randomBytes(1024 * 1024)
}

describe('large payload streaming', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await makeTempDir('devmig-archive-large-')
  })
  afterEach(async () => {
    await removeTempDir(tmp)
  })

  it('round trips 64 MiB with a bounded RSS delta', async () => {
    const staging = path.join(tmp, 'staging')
    await fs.mkdir(path.join(staging, 'projects', 'p1', 'git'), { recursive: true })
    const manifest = makeManifest()
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest))
    const big = path.join(staging, 'projects', 'p1', 'git', 'big.bundle')
    await pipeline(Readable.from(randomChunks(SIZE)), createWriteStream(big))
    await writeChecksumsFile(staging)
    const expectedHash = (await hashFile(big)).sha256

    const baseline = process.memoryUsage().rss
    const started = performance.now()
    const outputPath = path.join(tmp, 'large.devbackup')
    const created = await createDevBackup(
      fastCreateOptions({ sourceDir: staging, outputPath, password: PASSWORD, manifest }),
    )
    expect(created.payloadBytes).toBeGreaterThan(SIZE)
    expect(created.sizeBytes).toBeGreaterThan(SIZE)
    expect(created.sizeBytes - created.payloadBytes).toBeLessThan(64 * 1024) // header + 16 B per 1 MiB chunk

    const verified = await verifyDevBackup({ path: outputPath, password: PASSWORD })
    expect(verified.ok).toBe(true)
    expect(verified.bytes).toBeGreaterThanOrEqual(SIZE)

    const dest = path.join(tmp, 'dest')
    await extractDevBackup({ path: outputPath, password: PASSWORD, destinationDir: dest })
    const elapsed = performance.now() - started
    const delta = process.memoryUsage().rss - baseline
    expect((await hashFile(path.join(dest, 'projects', 'p1', 'git', 'big.bundle'))).sha256).toBe(
      expectedHash,
    )
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(SIZE)
    console.log(
      `64 MiB round trip: ${elapsed.toFixed(0)} ms, RSS delta ${(delta / 1024 / 1024).toFixed(0)} MB`,
    )
    expect(delta, `RSS grew by ${(delta / 1024 / 1024).toFixed(0)} MB`).toBeLessThan(
      400 * 1024 * 1024,
    )
    expect(elapsed, `create+verify+extract took ${elapsed.toFixed(0)} ms`).toBeLessThan(60_000)
  })
})
