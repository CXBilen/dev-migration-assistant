/**
 * Private 0700 staging directories holding extracted backup payloads (ADR-0008). One entry per backup
 * file (keyed by path + size + mtime) is kept while the app runs so that previewRemap, plan and execute
 * share a single extraction. The password is re-authenticated by the archive layer on every acquire.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DevBackupHeader, ExtractionLimits } from '@devmig/archive'
import type { Manifest } from '@devmig/model'
import { MigrationError, formatBytes, pathExists, type Logger } from '@devmig/shared'
import type { ArchiveAdapter } from '../archive-adapter'
import { clamp01 } from '../context'
import type { JobRunContext } from '../jobs/job-manager'

export interface StagingEntry {
  key: string
  backupPath: string
  /** <workDir>/restore-XXXX (0700) */
  stagingDir: string
  /** <stagingDir>/payload */
  payloadRoot: string
  header: DevBackupHeader
  manifest: Manifest
  sizeBytes: number
  checksumsVerified: boolean
  /** Plan ids that still depend on this staging directory. */
  readonly refs: Set<string>
}

export interface StagingCacheOptions {
  archive: ArchiveAdapter
  workDir: string
  logger: Logger
  extractionLimits?: Partial<ExtractionLimits>
  /** Free space required before extraction as a multiple of manifest.stats.payloadBytes (default 1.2). */
  freeSpaceFactor?: number
}

export async function rmQuiet(target: string | undefined, logger?: Logger): Promise<void> {
  if (!target) return
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 2 })
  } catch (err) {
    logger?.warn('Could not remove directory', {
      path: target,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Free bytes available to the current user on the volume holding `dir` (nearest existing ancestor). */
export async function freeSpaceBytes(dir: string): Promise<number | undefined> {
  let probe = dir
  for (;;) {
    try {
      const stats = await fs.statfs(probe)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return undefined
      probe = parent
    }
  }
}

export async function stagingKeyFor(
  backupPath: string,
): Promise<{ key: string; sizeBytes: number }> {
  const stat = await fs.stat(backupPath)
  return { key: `${backupPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`, sizeBytes: stat.size }
}

export class StagingCache {
  private readonly entries = new Map<string, StagingEntry>()
  private readonly inflight = new Map<string, Promise<StagingEntry>>()

  constructor(private readonly options: StagingCacheOptions) {}

  get(key: string): StagingEntry | undefined {
    return this.entries.get(key)
  }

  /** Returns the extracted payload for the backup, extracting it on first use. Always re-checks the password. */
  async acquire(backupPath: string, password: string, job: JobRunContext): Promise<StagingEntry> {
    const { key } = await stagingKeyFor(backupPath)
    const existing = this.entries.get(key)
    if (existing) {
      if (await pathExists(existing.payloadRoot)) {
        // The archive layer authenticates the password (wrong password -> ARCHIVE_AUTH_FAILED).
        const inspected = await this.options.archive.inspectDevBackup({
          path: backupPath,
          password,
          signal: job.signal,
        })
        if (inspected.manifest.id === existing.manifest.id) {
          this.options.logger.debug('Reusing extracted payload', { backupPath, key })
          return existing
        }
        this.options.logger.warn('Cached payload does not match the backup; re-extracting', { key })
        await this.remove(key)
      } else {
        this.entries.delete(key)
      }
    }
    const pending = this.inflight.get(key)
    if (pending) return pending
    const promise = this.extract(key, backupPath, password, job).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, promise)
    return promise
  }

  private async extract(
    key: string,
    backupPath: string,
    password: string,
    job: JobRunContext,
  ): Promise<StagingEntry> {
    const { archive, workDir, logger } = this.options
    const inspected = await archive.inspectDevBackup({
      path: backupPath,
      password,
      signal: job.signal,
    })
    const needed = Math.ceil(
      inspected.manifest.stats.payloadBytes * (this.options.freeSpaceFactor ?? 1.2),
    )
    await fs.mkdir(workDir, { recursive: true, mode: 0o700 })
    const free = await freeSpaceBytes(workDir)
    if (free !== undefined && free < needed) {
      throw new MigrationError(
        'DISK_FULL',
        `Not enough free space to extract the backup: ${formatBytes(needed)} needed, ${formatBytes(free)} available in ${workDir}.`,
        { details: { needed, free, workDir } },
      )
    }
    const stagingDir = await fs.mkdtemp(path.join(workDir, 'restore-'))
    await fs.chmod(stagingDir, 0o700)
    const payloadRoot = path.join(stagingDir, 'payload')
    await fs.mkdir(payloadRoot, { mode: 0o700 })
    try {
      const extracted = await archive.extractDevBackup({
        path: backupPath,
        password,
        destinationDir: payloadRoot,
        signal: job.signal,
        verifyChecksums: true,
        ...(this.options.extractionLimits ? { limits: this.options.extractionLimits } : {}),
        onProgress: (p) => {
          job.progress(p.message ?? `Extracting… ${p.entries} entries`, {
            ...(p.totalBytes ? { progress: clamp01(p.bytes / p.totalBytes) } : {}),
          })
        },
      })
      const entry: StagingEntry = {
        key,
        backupPath,
        stagingDir,
        payloadRoot,
        header: extracted.header,
        manifest: extracted.manifest,
        sizeBytes: inspected.sizeBytes,
        checksumsVerified: extracted.checksumsVerified,
        refs: new Set(),
      }
      this.entries.set(key, entry)
      logger.info('Extracted backup payload to staging', {
        backupPath,
        stagingDir,
        entries: extracted.entries,
        bytes: extracted.bytes,
      })
      return entry
    } catch (err) {
      await rmQuiet(stagingDir, logger)
      throw err
    }
  }

  retain(key: string, planId: string): void {
    this.entries.get(key)?.refs.add(planId)
  }

  release(key: string, planId: string): void {
    this.entries.get(key)?.refs.delete(planId)
  }

  async remove(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.options.logger.info('Removing staging directory', { stagingDir: entry.stagingDir })
    await rmQuiet(entry.stagingDir, this.options.logger)
  }

  /** Removes every staging directory no plan depends on. */
  async cleanup(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (entry.refs.size === 0) await this.remove(entry.key)
    }
  }

  async dispose(): Promise<void> {
    for (const entry of [...this.entries.values()]) await this.remove(entry.key)
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }
}
