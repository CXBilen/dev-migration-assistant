/**
 * Test double for the `.devbackup` container. Produces a single JSON file at `outputPath` holding the
 * header, a salted password hash, the manifest and every payload entry (base64). Behaves like the real
 * archive at the API level: wrong passwords fail before any payload is touched, unsafe entry paths are
 * rejected on extraction, extraction limits are honoured, checksums are verified.
 *
 * Never use this for real backups: it is not encrypted.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ArchiveProgress,
  CreateDevBackupOptions,
  CreateDevBackupResult,
  DevBackupHeader,
  ExtractDevBackupOptions,
  ExtractDevBackupResult,
  ExtractionLimits,
  InspectDevBackupOptions,
  InspectDevBackupResult,
  ReadHeaderResult,
  VerifyDevBackupOptions,
  VerifyDevBackupResult,
} from '@devmig/archive'
import { Manifest as ManifestSchema, type Checksums, type Manifest } from '@devmig/model'
import {
  MigrationError,
  hashFile,
  isSafeArchivePath,
  newId,
  pathExists,
  throwIfAborted,
  toPosix,
  walkFiles,
} from '@devmig/shared'
import type { ArchiveAdapter, ComputeChecksumsOptions } from '../archive-adapter'

export const FAKE_ARCHIVE_MAGIC = 'DEVBKP-FAKE' as const
export const CHECKSUMS_FILE = 'checksums.json'

interface FakeEntry {
  path: string
  sizeBytes: number
  sha256: string
  dataBase64: string
}

interface FakeContainer {
  magic: typeof FAKE_ARCHIVE_MAGIC
  header: DevBackupHeader
  passwordSalt: string
  passwordHash: string
  manifest: Manifest
  entries: FakeEntry[]
}

export type FakeArchiveOperation = 'create' | 'readHeader' | 'inspect' | 'extract' | 'verify'

export interface FakeArchiveAdapterOptions {
  /** Format version written into headers (default 1). */
  formatVersion?: number
  /** Simulated failure: throw the produced error when the given operation runs. */
  failOn?: Partial<Record<FakeArchiveOperation, () => Error>>
  /** Hook awaited before the create operation writes anything (lets tests block / cancel mid-way). */
  beforeCreate?: (opts: CreateDevBackupOptions) => Promise<void>
  /** Limits applied on extraction when the caller passes none. */
  defaultLimits?: ExtractionLimits
}

const DEFAULT_LIMITS: ExtractionLimits = {
  maxTotalBytes: 1024 ** 3,
  maxEntries: 100_000,
  maxEntryBytes: 256 * 1024 ** 2,
  maxPathLength: 1024,
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hashPassword(password: string, salt: string): string {
  return sha256(`${salt} ${password}`)
}

export interface FakeArchiveCall {
  op: FakeArchiveOperation
  path: string
}

/** Streams every file under rootDir through SHA-256; checksums.json itself is excluded. */
export async function computeChecksumsForDir(
  rootDir: string,
  opts: ComputeChecksumsOptions = {},
): Promise<Checksums> {
  const entries: Checksums['entries'] = []
  for await (const file of walkFiles(rootDir, { signal: opts.signal })) {
    if (!file.dirent.isFile()) continue
    const rel = toPosix(file.relativePath)
    if (rel === CHECKSUMS_FILE) continue
    const { sha256: digest, sizeBytes } = await hashFile(file.absolutePath, opts.signal)
    entries.push({ path: rel, sha256: digest, sizeBytes })
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { algorithm: 'sha256', entries }
}

function parseChecksums(entry: FakeEntry): Checksums {
  return JSON.parse(Buffer.from(entry.dataBase64, 'base64').toString('utf8')) as Checksums
}

export class FakeArchiveAdapter implements ArchiveAdapter {
  readonly calls: FakeArchiveCall[] = []

  constructor(private readonly options: FakeArchiveAdapterOptions = {}) {}

  private maybeFail(op: FakeArchiveOperation): void {
    const factory = this.options.failOn?.[op]
    if (factory) throw factory()
  }

  private async readContainer(
    filePath: string,
  ): Promise<{ container: FakeContainer; sizeBytes: number }> {
    let raw: string
    let sizeBytes: number
    try {
      const stat = await fs.stat(filePath)
      sizeBytes = stat.size
      raw = await fs.readFile(filePath, 'utf8')
    } catch (err) {
      throw new MigrationError('PATH_NOT_FOUND', `Backup file not found: ${filePath}`, {
        details: { path: filePath },
        cause: err,
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new MigrationError('ARCHIVE_INVALID', 'Not a fake .devbackup container (invalid JSON).')
    }
    const container = parsed as Partial<FakeContainer> | null
    if (
      !container ||
      container.magic !== FAKE_ARCHIVE_MAGIC ||
      !container.header ||
      typeof container.passwordHash !== 'string' ||
      typeof container.passwordSalt !== 'string' ||
      !Array.isArray(container.entries)
    ) {
      throw new MigrationError('ARCHIVE_INVALID', 'Not a fake .devbackup container (bad magic).')
    }
    return { container: container as FakeContainer, sizeBytes }
  }

  private authenticate(container: FakeContainer, password: string): void {
    if (hashPassword(password, container.passwordSalt) !== container.passwordHash) {
      throw new MigrationError(
        'ARCHIVE_AUTH_FAILED',
        'Wrong password or corrupted backup header.',
        {
          hint: 'Check the password and try again.',
          recoverable: true,
        },
      )
    }
  }

  async createDevBackup(opts: CreateDevBackupOptions): Promise<CreateDevBackupResult> {
    this.calls.push({ op: 'create', path: opts.outputPath })
    this.maybeFail('create')
    if (this.options.beforeCreate) await this.options.beforeCreate(opts)
    throwIfAborted(opts.signal)
    const manifestPath = path.join(opts.sourceDir, 'manifest.json')
    try {
      await fs.access(manifestPath)
    } catch {
      throw new MigrationError('MANIFEST_INVALID', 'sourceDir must contain manifest.json', {
        details: { sourceDir: opts.sourceDir },
      })
    }
    const checksums = await computeChecksumsForDir(opts.sourceDir, { signal: opts.signal })
    const entries: FakeEntry[] = []
    let payloadBytes = 0
    const files: string[] = []
    for await (const file of walkFiles(opts.sourceDir, { signal: opts.signal })) {
      if (file.dirent.isFile()) files.push(toPosix(file.relativePath))
    }
    // manifest.json first, checksums.json last, like the real tar stream.
    const rank = (p: string): number => (p === 'manifest.json' ? 0 : p === CHECKSUMS_FILE ? 2 : 1)
    files.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    for (const rel of files) {
      throwIfAborted(opts.signal)
      const data = await fs.readFile(path.join(opts.sourceDir, ...rel.split('/')))
      entries.push({
        path: rel,
        sizeBytes: data.length,
        sha256: sha256(data),
        dataBase64: data.toString('base64'),
      })
      payloadBytes += data.length
      const progress: ArchiveProgress = {
        bytes: payloadBytes,
        entries: entries.length,
        message: `Packed ${rel}`,
      }
      opts.onProgress?.(progress)
    }
    const passwordSalt = newId()
    const header: DevBackupHeader = {
      magic: 'DEVBKP',
      formatVersion: this.options.formatVersion ?? 1,
      cipher: 'aes-256-gcm',
      chunkSize: 1024 * 1024,
      kdf: {
        algorithm: 'argon2id',
        memoryKiB: 8 * 1024,
        iterations: 1,
        parallelism: 1,
        saltBase64: Buffer.from(passwordSalt).toString('base64'),
      },
      wrappedMasterKey: Buffer.from('fake-master-key').toString('base64'),
      createdAt: new Date().toISOString(),
      backupId: opts.manifest.id,
      appVersion: opts.manifest.appVersion,
    }
    const container: FakeContainer = {
      magic: FAKE_ARCHIVE_MAGIC,
      header,
      passwordSalt,
      passwordHash: hashPassword(opts.password, passwordSalt),
      manifest: opts.manifest,
      entries,
    }
    // Write like the real thing: temp + rename, refusing to clobber an existing file.
    if (await pathExists(opts.outputPath)) {
      throw new MigrationError('INVALID_INPUT', `Output file already exists: ${opts.outputPath}`, {
        details: { outputPath: opts.outputPath },
      })
    }
    const tmp = `${opts.outputPath}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(container), { mode: 0o600, flag: 'wx' })
    try {
      await fs.rename(tmp, opts.outputPath)
    } catch (err) {
      await fs.rm(tmp, { force: true })
      throw err
    }
    const sizeBytes = (await fs.stat(opts.outputPath)).size
    return {
      outputPath: opts.outputPath,
      sizeBytes,
      payloadBytes,
      entries: entries.length,
      checksums,
    }
  }

  async readDevBackupHeader(filePath: string): Promise<ReadHeaderResult> {
    this.calls.push({ op: 'readHeader', path: filePath })
    this.maybeFail('readHeader')
    const { container, sizeBytes } = await this.readContainer(filePath)
    return {
      header: container.header,
      sizeBytes,
      supported: container.header.formatVersion === (this.options.formatVersion ?? 1),
    }
  }

  async inspectDevBackup(opts: InspectDevBackupOptions): Promise<InspectDevBackupResult> {
    this.calls.push({ op: 'inspect', path: opts.path })
    this.maybeFail('inspect')
    throwIfAborted(opts.signal)
    const { container, sizeBytes } = await this.readContainer(opts.path)
    this.authenticate(container, opts.password)
    return {
      header: container.header,
      manifest: ManifestSchema.parse(container.manifest),
      sizeBytes,
    }
  }

  async extractDevBackup(opts: ExtractDevBackupOptions): Promise<ExtractDevBackupResult> {
    this.calls.push({ op: 'extract', path: opts.path })
    this.maybeFail('extract')
    throwIfAborted(opts.signal)
    const { container } = await this.readContainer(opts.path)
    this.authenticate(container, opts.password)
    const limits: ExtractionLimits = {
      ...(this.options.defaultLimits ?? DEFAULT_LIMITS),
      ...(opts.limits ?? {}),
    }
    if (container.entries.length > limits.maxEntries) {
      throw new MigrationError(
        'ARCHIVE_LIMIT_EXCEEDED',
        `Too many entries: ${container.entries.length}`,
      )
    }
    let total = 0
    let written = 0
    await fs.mkdir(opts.destinationDir, { recursive: true, mode: 0o700 })
    for (const entry of container.entries) {
      throwIfAborted(opts.signal)
      if (!isSafeArchivePath(entry.path) || entry.path.length > limits.maxPathLength) {
        throw new MigrationError(
          'ARCHIVE_ENTRY_REJECTED',
          `Rejected archive entry: ${entry.path}`,
          {
            details: { path: entry.path },
          },
        )
      }
      const data = Buffer.from(entry.dataBase64, 'base64')
      if (data.length > limits.maxEntryBytes) {
        throw new MigrationError('ARCHIVE_LIMIT_EXCEEDED', `Entry too large: ${entry.path}`)
      }
      total += data.length
      if (total > limits.maxTotalBytes) {
        throw new MigrationError('ARCHIVE_LIMIT_EXCEEDED', 'Payload exceeds the extraction limit.')
      }
      if (sha256(data) !== entry.sha256) {
        throw new MigrationError('INTEGRITY_MISMATCH', `Entry checksum mismatch: ${entry.path}`)
      }
      const target = path.join(opts.destinationDir, ...entry.path.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await fs.writeFile(target, data, { mode: 0o600 })
      written += 1
      opts.onProgress?.({ bytes: total, entries: written, message: `Extracted ${entry.path}` })
    }
    let checksumsVerified = false
    if (opts.verifyChecksums !== false) {
      const checksumsEntry = container.entries.find((e) => e.path === CHECKSUMS_FILE)
      if (!checksumsEntry) {
        throw new MigrationError('ARCHIVE_INVALID', 'checksums.json is missing from the payload.')
      }
      const checksums = parseChecksums(checksumsEntry)
      const actual = await computeChecksumsForDir(opts.destinationDir, { signal: opts.signal })
      const expectedMap = new Map(checksums.entries.map((e) => [e.path, e.sha256]))
      for (const a of actual.entries) {
        if (expectedMap.get(a.path) !== a.sha256) {
          throw new MigrationError('INTEGRITY_MISMATCH', `Checksum mismatch for ${a.path}`)
        }
      }
      if (actual.entries.length !== checksums.entries.length) {
        throw new MigrationError(
          'INTEGRITY_MISMATCH',
          'checksums.json does not cover every payload file.',
        )
      }
      checksumsVerified = true
    }
    return {
      header: container.header,
      manifest: ManifestSchema.parse(container.manifest),
      entries: written,
      bytes: total,
      checksumsVerified,
    }
  }

  async verifyDevBackup(opts: VerifyDevBackupOptions): Promise<VerifyDevBackupResult> {
    this.calls.push({ op: 'verify', path: opts.path })
    this.maybeFail('verify')
    throwIfAborted(opts.signal)
    const { container } = await this.readContainer(opts.path)
    this.authenticate(container, opts.password)
    let bytes = 0
    let entries = 0
    const checksumsEntry = container.entries.find((e) => e.path === CHECKSUMS_FILE)
    const expected = checksumsEntry
      ? new Map(parseChecksums(checksumsEntry).entries.map((e) => [e.path, e.sha256] as const))
      : undefined
    for (const entry of container.entries) {
      throwIfAborted(opts.signal)
      const data = Buffer.from(entry.dataBase64, 'base64')
      const digest = sha256(data)
      if (digest !== entry.sha256) {
        throw new MigrationError('INTEGRITY_MISMATCH', `Entry checksum mismatch: ${entry.path}`)
      }
      if (expected && entry.path !== CHECKSUMS_FILE && expected.get(entry.path) !== digest) {
        throw new MigrationError('INTEGRITY_MISMATCH', `checksums.json mismatch for ${entry.path}`)
      }
      bytes += data.length
      entries += 1
      opts.onProgress?.({ bytes, entries, message: `Verified ${entry.path}` })
    }
    return {
      header: container.header,
      manifest: ManifestSchema.parse(container.manifest),
      entries,
      bytes,
      ok: true,
    }
  }

  computeChecksums(rootDir: string, opts?: ComputeChecksumsOptions): Promise<Checksums> {
    return computeChecksumsForDir(rootDir, opts)
  }

  async writeChecksumsFile(rootDir: string): Promise<Checksums> {
    const checksums = await computeChecksumsForDir(rootDir)
    await fs.writeFile(path.join(rootDir, CHECKSUMS_FILE), JSON.stringify(checksums, null, 2), {
      mode: 0o600,
    })
    return checksums
  }

  /** Test helper: lists the payload entry paths stored in a fake container. */
  async listEntries(filePath: string): Promise<string[]> {
    const { container } = await this.readContainer(filePath)
    return container.entries.map((e) => e.path)
  }

  /** Test helper: reads one payload entry from a fake container. */
  async readEntry(filePath: string, entryPath: string): Promise<Buffer | undefined> {
    const { container } = await this.readContainer(filePath)
    const entry = container.entries.find((e) => e.path === entryPath)
    return entry ? Buffer.from(entry.dataBase64, 'base64') : undefined
  }

  /** Test helper: rewrites the stored manifest (to simulate unknown providers, old formats, tampering). */
  async patchManifest(filePath: string, patch: (manifest: Manifest) => Manifest): Promise<void> {
    const { container } = await this.readContainer(filePath)
    container.manifest = patch(container.manifest)
    const manifestEntry = container.entries.find((e) => e.path === 'manifest.json')
    if (manifestEntry) {
      const data = Buffer.from(JSON.stringify(container.manifest, null, 2), 'utf8')
      manifestEntry.dataBase64 = data.toString('base64')
      manifestEntry.sizeBytes = data.length
      manifestEntry.sha256 = sha256(data)
      const checksumsEntry = container.entries.find((e) => e.path === CHECKSUMS_FILE)
      if (checksumsEntry) {
        const checksums = parseChecksums(checksumsEntry)
        for (const e of checksums.entries) {
          if (e.path === 'manifest.json') {
            e.sha256 = manifestEntry.sha256
            e.sizeBytes = data.length
          }
        }
        const cdata = Buffer.from(JSON.stringify(checksums, null, 2), 'utf8')
        checksumsEntry.dataBase64 = cdata.toString('base64')
        checksumsEntry.sizeBytes = cdata.length
        checksumsEntry.sha256 = sha256(cdata)
      }
    }
    await fs.writeFile(filePath, JSON.stringify(container), { mode: 0o600 })
  }
}
