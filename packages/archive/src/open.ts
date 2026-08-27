/**
 * Opens a .devbackup for reading: header → KDF → master-key unwrap → content key.
 * No payload byte is read before the password has been verified against the wrapped key.
 */
import { createReadStream, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import fsCallbacks from 'node:fs'
import type { Readable } from 'node:stream'
import { MigrationError, throwIfAborted, type Logger, noopLogger } from '@devmig/shared'
import { GCM_TAG_LENGTH, READ_HIGH_WATER_MARK } from './constants'
import { createDecryptStream, type DecryptStream } from './crypto-stream'
import { toMigrationError } from './errors'
import { readHeaderFromHandle } from './header'
import { decodeBase64, deriveKeyFromPassword, validateKdfParams } from './kdf'
import { deriveContentKey, hashHeaderBytes, unwrapMasterKey } from './keys'
import type { DevBackupHeader } from './types'

export interface OpenedDevBackup {
  path: string
  sizeBytes: number
  header: DevBackupHeader
  headerBytes: Buffer
  headerHash: Buffer
  payloadOffset: number
  contentKey: Buffer
  ciphertextBytes: number
  chunkCount: number
  /** Exact plaintext size implied by the ciphertext length (0 when malformed). */
  plaintextBytes: number
}

export interface OpenOptions {
  signal?: AbortSignal
  logger?: Logger
}

export async function openDevBackup(
  path: string,
  password: string,
  opts: OpenOptions = {},
): Promise<OpenedDevBackup> {
  const logger = opts.logger ?? noopLogger
  if (typeof password !== 'string' || password.length === 0) {
    throw new MigrationError('INVALID_INPUT', 'A password is required.')
  }
  let handle: FileHandle
  try {
    handle = await fs.open(path, 'r')
  } catch (err) {
    throw toMigrationError(err)
  }
  let parsed
  try {
    parsed = await readHeaderFromHandle(handle)
  } finally {
    await handle.close()
  }
  if (!parsed.supported) {
    throw new MigrationError(
      'ARCHIVE_UNSUPPORTED_VERSION',
      `This backup uses format version ${parsed.header.formatVersion}, which this app cannot read.`,
      {
        hint: 'Update Dev Migration Assistant to a newer version to restore this backup.',
        details: { formatVersion: parsed.header.formatVersion },
      },
    )
  }
  throwIfAborted(opts.signal)
  const { header } = parsed
  const salt = validateKdfParams(header.kdf, 'ARCHIVE_INVALID')
  logger.debug('Deriving key', {
    memoryKiB: header.kdf.memoryKiB,
    iterations: header.kdf.iterations,
    parallelism: header.kdf.parallelism,
  })
  const kek = await deriveKeyFromPassword(password, header.kdf, { signal: opts.signal })
  const wrapped = decodeBase64(header.wrappedMasterKey, 'wrappedMasterKey', 'ARCHIVE_INVALID')
  const masterKey = unwrapMasterKey(kek, wrapped)
  kek.fill(0)
  const contentKey = deriveContentKey(masterKey, salt)
  masterKey.fill(0)
  const ciphertextBytes = Math.max(0, parsed.sizeBytes - parsed.payloadOffset)
  const chunkCount = Math.max(1, Math.ceil(ciphertextBytes / (header.chunkSize + GCM_TAG_LENGTH)))
  return {
    path,
    sizeBytes: parsed.sizeBytes,
    header,
    headerBytes: parsed.headerBytes,
    headerHash: hashHeaderBytes(parsed.headerBytes),
    payloadOffset: parsed.payloadOffset,
    contentKey,
    ciphertextBytes,
    chunkCount,
    plaintextBytes: Math.max(0, ciphertextBytes - GCM_TAG_LENGTH * chunkCount),
  }
}

export interface PayloadSourceOptions {
  /** Invoked with the cumulative number of bytes actually read from disk. */
  onRead?: (bytesRead: number) => void
}

/** Read stream over the ciphertext region with an exact count of bytes read from disk. */
export function createPayloadSource(
  opened: OpenedDevBackup,
  opts: PayloadSourceOptions = {},
): Readable {
  let bytesRead = 0
  return createReadStream(opened.path, {
    start: opened.payloadOffset,
    highWaterMark: READ_HIGH_WATER_MARK,
    fs: {
      open: fsCallbacks.open,
      close: fsCallbacks.close,
      read: (
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | bigint | null,
        cb: (
          err: NodeJS.ErrnoException | null,
          bytesRead: number,
          buffer: NodeJS.ArrayBufferView,
        ) => void,
      ) =>
        fsCallbacks.read(fd, buffer, offset, length, position, (err, n, buf) => {
          if (!err) {
            bytesRead += n
            opts.onRead?.(bytesRead)
          }
          cb(err, n, buf)
        }),
    },
  })
}

export function createPayloadDecryptor(
  opened: OpenedDevBackup,
  onChunk?: (plaintextBytes: number, chunkIndex: number) => void,
): DecryptStream {
  return createDecryptStream({
    contentKey: opened.contentKey,
    headerHash: opened.headerHash,
    chunkSize: opened.header.chunkSize,
    totalCiphertextBytes: opened.ciphertextBytes,
    onChunk,
  })
}
