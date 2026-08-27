import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Manifest as ManifestSchema } from '@devmig/model'
import { MigrationError, noopLogger, throwIfAborted } from '@devmig/shared'
import { parseChecksums, writeChecksumsFile } from './checksums'
import {
  CHECKSUMS_ENTRY,
  DEFAULT_CHUNK_SIZE,
  MANIFEST_ENTRY,
  MAX_CHECKSUMS_BYTES,
  MAX_CHUNK_SIZE,
  MAX_MANIFEST_BYTES,
  MIN_CHUNK_SIZE,
  PARTIAL_SUFFIX,
  SALT_LENGTH,
} from './constants'
import { createEncryptStream } from './crypto-stream'
import { toMigrationError } from './errors'
import { buildHeader, encodeHeader } from './header'
import { deriveKeyFromPassword, resolveKdfPreset } from './kdf'
import {
  deriveContentKey,
  generateMasterKey,
  generateSalt,
  hashHeaderBytes,
  wrapMasterKey,
} from './keys'
import { createPayloadPack, planPayload } from './pack'
import { createProgressReporter } from './progress'
import type { CreateDevBackupOptions, CreateDevBackupResult } from './types'

async function readBounded(filePath: string, maxBytes: number, label: string): Promise<Buffer> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) {
    throw new MigrationError('INVALID_INPUT', `${label} is not a regular file.`, {
      details: { path: filePath },
    })
  }
  if (stat.size > maxBytes) {
    throw new MigrationError(
      'ARCHIVE_LIMIT_EXCEEDED',
      `${label} is larger than ${maxBytes} bytes.`,
      {
        details: { path: filePath, size: stat.size, max: maxBytes },
      },
    )
  }
  return fs.readFile(filePath)
}

async function fsyncDirectory(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Best effort: some filesystems refuse fsync on directories.
  }
}

/**
 * Packs `sourceDir` (manifest.json first, checksums.json last) into an encrypted .devbackup.
 * Writes `<outputPath>.partial`, fsyncs, then renames; on any failure or cancellation the
 * partial file is removed and nothing is left behind.
 */
export async function createDevBackup(
  opts: CreateDevBackupOptions,
): Promise<CreateDevBackupResult> {
  const logger = opts.logger ?? noopLogger
  const { signal } = opts
  if (typeof opts.password !== 'string' || opts.password.length === 0) {
    throw new MigrationError('INVALID_INPUT', 'A password is required.')
  }
  const manifestCheck = ManifestSchema.safeParse(opts.manifest)
  if (!manifestCheck.success) {
    throw new MigrationError('MANIFEST_INVALID', 'The manifest does not match the schema.', {
      details: {
        issues: manifestCheck.error.issues
          .slice(0, 20)
          .map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    })
  }
  const manifest = manifestCheck.data
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new MigrationError('INVALID_INPUT', 'chunkSize out of range.', {
      details: { chunkSize, min: MIN_CHUNK_SIZE, max: MAX_CHUNK_SIZE },
    })
  }
  const sourceDir = path.resolve(opts.sourceDir)
  const outputPath = path.resolve(opts.outputPath)
  let sourceStat
  try {
    sourceStat = await fs.stat(sourceDir)
  } catch (err) {
    throw toMigrationError(err)
  }
  if (!sourceStat.isDirectory()) {
    throw new MigrationError('NOT_A_DIRECTORY', `Source is not a directory: ${sourceDir}`)
  }
  const outputDir = path.dirname(outputPath)
  let outputDirStat
  try {
    outputDirStat = await fs.stat(outputDir)
  } catch (err) {
    throw toMigrationError(err)
  }
  if (!outputDirStat.isDirectory()) {
    throw new MigrationError('NOT_A_DIRECTORY', `Output directory does not exist: ${outputDir}`)
  }

  // manifest.json on disk must be the manifest we were given (same id) and valid.
  const manifestPath = path.join(sourceDir, MANIFEST_ENTRY)
  let manifestBytes: Buffer
  try {
    manifestBytes = await readBounded(manifestPath, MAX_MANIFEST_BYTES, MANIFEST_ENTRY)
  } catch (err) {
    if (err instanceof MigrationError) throw err
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MigrationError(
        'INVALID_INPUT',
        `${MANIFEST_ENTRY} is missing from the source directory.`,
        {
          details: { path: manifestPath },
        },
      )
    }
    throw toMigrationError(err)
  }
  let diskManifest
  try {
    diskManifest = ManifestSchema.safeParse(JSON.parse(manifestBytes.toString('utf8')))
  } catch (err) {
    throw new MigrationError(
      'MANIFEST_INVALID',
      `${MANIFEST_ENTRY} in the source directory is not valid JSON.`,
      {
        details: { path: manifestPath },
        cause: err,
      },
    )
  }
  if (!diskManifest.success) {
    throw new MigrationError(
      'MANIFEST_INVALID',
      `${MANIFEST_ENTRY} in the source directory is invalid.`,
      {
        details: { path: manifestPath },
      },
    )
  }
  if (diskManifest.data.id !== manifest.id) {
    throw new MigrationError(
      'INVALID_INPUT',
      `${MANIFEST_ENTRY} on disk does not belong to the given manifest.`,
      {
        details: { disk: diskManifest.data.id, given: manifest.id },
      },
    )
  }

  // checksums.json: reuse a valid existing file (the engine writes it) or create it.
  const checksumsPath = path.join(sourceDir, CHECKSUMS_ENTRY)
  let checksums
  try {
    await fs.access(checksumsPath)
    checksums = parseChecksums(
      await readBounded(checksumsPath, MAX_CHECKSUMS_BYTES, CHECKSUMS_ENTRY),
      'INVALID_INPUT',
    )
  } catch (err) {
    if (err instanceof MigrationError) throw err
    logger.debug('checksums.json missing; computing', { sourceDir })
    checksums = await writeChecksumsFile(sourceDir)
  }
  throwIfAborted(signal)

  const plan = await planPayload(sourceDir, { signal })
  for (const skipped of plan.skipped) logger.warn('Skipping non-regular file', { path: skipped })
  throwIfAborted(signal)

  // Key hierarchy.
  const kdfPreset = resolveKdfPreset(opts.kdf)
  const salt = generateSalt(SALT_LENGTH)
  const kdf = { ...kdfPreset, saltBase64: salt.toString('base64') }
  const kek = await deriveKeyFromPassword(opts.password, kdf, {
    signal,
    boundsErrorCode: 'INVALID_INPUT',
  })
  const masterKey = generateMasterKey()
  const wrapped = wrapMasterKey(kek, masterKey)
  kek.fill(0)
  const header = buildHeader({
    chunkSize,
    kdf,
    wrappedMasterKey: wrapped.toString('base64'),
    createdAt: new Date().toISOString(),
    backupId: manifest.id,
    appVersion: manifest.appVersion,
  })
  const headerBytes = encodeHeader(header)
  const headerHash = hashHeaderBytes(headerBytes)
  const contentKey = deriveContentKey(masterKey, salt)
  masterKey.fill(0)

  const partialPath = `${outputPath}${PARTIAL_SUFFIX}`
  const progress = createProgressReporter(opts.onProgress, plan.tarBytesEstimate)
  let entries = 0
  let payloadBytes = 0
  await fs.rm(partialPath, { force: true })
  try {
    // 'wx': never clobber a concurrent writer; flush: fsync before the stream closes.
    const writeStream = createWriteStream(partialPath, { flags: 'wx', mode: 0o600, flush: true })
    const opened = new Promise<void>((resolve, reject) => {
      writeStream.once('open', () => resolve())
      writeStream.once('error', reject)
    })
    await opened
    await new Promise<void>((resolve, reject) => {
      writeStream.write(headerBytes, (err) => (err ? reject(err) : resolve()))
    })
    const pack = createPayloadPack(sourceDir, plan, {
      onEntry: (count) => {
        entries = count
        progress.report({
          bytes: payloadBytes,
          entries,
          message: `Packing ${count} of ${plan.entries.length} entries`,
        })
      },
    })
    const encrypt = createEncryptStream({
      contentKey,
      headerHash,
      chunkSize,
      onChunk: (bytes) => {
        payloadBytes = bytes
        progress.report({ bytes, entries, message: 'Encrypting…' })
      },
    })
    await pipeline(pack, encrypt, writeStream, { signal })
    payloadBytes = encrypt.bytesIn
    await fs.rename(partialPath, outputPath)
    await fsyncDirectory(outputDir)
  } catch (err) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined)
    throw toMigrationError(err)
  } finally {
    contentKey.fill(0)
  }
  const stat = await fs.stat(outputPath)
  progress.report({ bytes: payloadBytes, entries, message: 'Backup written' }, true)
  logger.info('Backup created', { outputPath, sizeBytes: stat.size, entries, payloadBytes })
  return {
    outputPath,
    sizeBytes: stat.size,
    payloadBytes,
    entries: plan.entries.length,
    checksums,
    warnings: plan.skipped.map((p) => `Skipped non-regular file: ${p}`),
  }
}
