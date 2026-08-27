/**
 * Header codec: the unencrypted, AAD-authenticated prefix of a .devbackup file.
 *
 *   offset 0   magic "DEVBKP" (6 bytes)
 *   offset 6   u16 BE formatVersion
 *   offset 8   u32 BE headerJsonLength (L)
 *   offset 12  headerJson (UTF-8, L bytes, JSON.stringify output with fixed key order)
 *   offset 12+L ciphertext chunks
 */
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { MigrationError } from '@devmig/shared'
import { z } from 'zod'
import {
  CIPHER_ALGORITHM,
  FIXED_PREFIX_LENGTH,
  FORMAT_VERSION,
  KDF_BOUNDS,
  MAGIC,
  MAGIC_STRING,
  MAX_CHUNK_SIZE,
  MAX_HEADER_JSON_LENGTH,
  MIN_CHUNK_SIZE,
  WRAPPED_KEY_LENGTH,
} from './constants'
import { invalid } from './errors'
import { decodeBase64, validateKdfParams } from './kdf'
import type { DevBackupHeader, KdfParams, ReadHeaderResult } from './types'

const KdfParamsSchema = z.object({
  algorithm: z.literal('argon2id'),
  memoryKiB: z.number().int().min(KDF_BOUNDS.minMemoryKiB).max(KDF_BOUNDS.maxMemoryKiB),
  iterations: z.number().int().min(KDF_BOUNDS.minIterations).max(KDF_BOUNDS.maxIterations),
  parallelism: z.number().int().min(KDF_BOUNDS.minParallelism).max(KDF_BOUNDS.maxParallelism),
  saltBase64: z.string().min(1).max(128),
})

/** Strict v1 header schema (unknown keys are ignored: additive fields stay compatible within v1). */
export const DevBackupHeaderSchema = z.object({
  magic: z.literal(MAGIC_STRING),
  formatVersion: z.number().int().positive(),
  cipher: z.literal(CIPHER_ALGORITHM),
  chunkSize: z.number().int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE),
  kdf: KdfParamsSchema,
  wrappedMasterKey: z.string().min(1).max(256),
  createdAt: z.string().min(1).max(64),
  backupId: z.string().min(1).max(256),
  appVersion: z.string().max(64),
})

/** Lenient shape used only to describe headers of newer (unsupported) format versions. */
const LooseHeaderSchema = z.object({
  cipher: z.string().max(64).optional(),
  chunkSize: z.number().int().optional(),
  kdf: z
    .object({
      algorithm: z.string().max(64).optional(),
      memoryKiB: z.number().int().optional(),
      iterations: z.number().int().optional(),
      parallelism: z.number().int().optional(),
      saltBase64: z.string().max(128).optional(),
    })
    .optional(),
  wrappedMasterKey: z.string().max(256).optional(),
  createdAt: z.string().max(64).optional(),
  backupId: z.string().max(256).optional(),
  appVersion: z.string().max(64).optional(),
})

export interface HeaderFields {
  chunkSize: number
  kdf: KdfParams
  wrappedMasterKey: string
  createdAt: string
  backupId: string
  appVersion: string
}

/** Builds a header object with the fixed key order the spec prescribes. */
export function buildHeader(fields: HeaderFields): DevBackupHeader {
  return {
    magic: MAGIC_STRING,
    formatVersion: FORMAT_VERSION,
    cipher: CIPHER_ALGORITHM,
    chunkSize: fields.chunkSize,
    kdf: {
      algorithm: 'argon2id',
      memoryKiB: fields.kdf.memoryKiB,
      iterations: fields.kdf.iterations,
      parallelism: fields.kdf.parallelism,
      saltBase64: fields.kdf.saltBase64,
    },
    wrappedMasterKey: fields.wrappedMasterKey,
    createdAt: fields.createdAt,
    backupId: fields.backupId,
    appVersion: fields.appVersion,
  }
}

/** Serialises magic || version || length || json. The result is exactly what the AAD hash covers. */
export function encodeHeader(header: DevBackupHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  if (json.length > MAX_HEADER_JSON_LENGTH) {
    throw new MigrationError('INVALID_INPUT', 'Backup header is too large.', {
      details: { length: json.length, max: MAX_HEADER_JSON_LENGTH },
    })
  }
  const prefix = Buffer.alloc(FIXED_PREFIX_LENGTH)
  MAGIC.copy(prefix, 0)
  prefix.writeUInt16BE(header.formatVersion, 6)
  prefix.writeUInt32BE(json.length, 8)
  return Buffer.concat([prefix, json])
}

export interface ParsedHeader {
  header: DevBackupHeader
  /** Raw bytes [0, 12 + L): the AAD input. */
  headerBytes: Buffer
  /** Offset of the first ciphertext chunk (= headerBytes.length). */
  payloadOffset: number
  sizeBytes: number
  /** False when formatVersion is newer than this reader; `header` is then best-effort. */
  supported: boolean
  /** Decoded (but not validated) header JSON. */
  raw: unknown
}

function fillUnsupported(formatVersion: number, raw: unknown): DevBackupHeader {
  const loose = LooseHeaderSchema.safeParse(raw)
  const l = loose.success ? loose.data : {}
  return {
    magic: MAGIC_STRING,
    formatVersion,
    // Informational only: an unsupported version is never decrypted, so the literal type is a best-effort label.
    cipher: (l.cipher ?? CIPHER_ALGORITHM) as DevBackupHeader['cipher'],
    chunkSize: l.chunkSize ?? 0,
    kdf: {
      algorithm: (l.kdf?.algorithm ?? 'argon2id') as KdfParams['algorithm'],
      memoryKiB: l.kdf?.memoryKiB ?? 0,
      iterations: l.kdf?.iterations ?? 0,
      parallelism: l.kdf?.parallelism ?? 0,
      saltBase64: l.kdf?.saltBase64 ?? '',
    },
    wrappedMasterKey: l.wrappedMasterKey ?? '',
    createdAt: l.createdAt ?? '',
    backupId: l.backupId ?? '',
    appVersion: l.appVersion ?? '',
  }
}

/** Parses a complete in-memory header prefix (used by tests and by readHeaderFromHandle). */
export function parseHeaderBytes(bytes: Buffer, sizeBytes: number): ParsedHeader {
  if (bytes.length < FIXED_PREFIX_LENGTH) {
    throw invalid('The file is too short to be a .devbackup archive.', { sizeBytes })
  }
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw invalid('Not a .devbackup archive (bad magic).')
  }
  const formatVersion = bytes.readUInt16BE(6)
  const length = bytes.readUInt32BE(8)
  if (formatVersion === 0) throw invalid('Invalid format version 0.')
  if (length < 2 || length > MAX_HEADER_JSON_LENGTH) {
    throw invalid('Invalid header length.', { length, max: MAX_HEADER_JSON_LENGTH })
  }
  if (bytes.length < FIXED_PREFIX_LENGTH + length) {
    throw invalid('The archive is truncated inside its header.', {
      length,
      available: bytes.length - FIXED_PREFIX_LENGTH,
    })
  }
  const headerBytes = bytes.subarray(0, FIXED_PREFIX_LENGTH + length)
  const jsonBytes = headerBytes.subarray(FIXED_PREFIX_LENGTH)
  let raw: unknown
  try {
    raw = JSON.parse(jsonBytes.toString('utf8')) as unknown
  } catch (err) {
    throw invalid('The archive header is not valid JSON.', { cause: String(err) })
  }
  const supported = formatVersion === FORMAT_VERSION
  if (!supported) {
    return {
      header: fillUnsupported(formatVersion, raw),
      headerBytes: Buffer.from(headerBytes),
      payloadOffset: headerBytes.length,
      sizeBytes,
      supported: false,
      raw,
    }
  }
  const parsed = DevBackupHeaderSchema.safeParse(raw)
  if (!parsed.success) {
    throw invalid('The archive header is malformed.', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    })
  }
  const header = parsed.data
  if (header.formatVersion !== formatVersion) {
    throw invalid('The header JSON disagrees with the binary format version.', {
      binary: formatVersion,
      json: header.formatVersion,
    })
  }
  validateKdfParams(header.kdf, 'ARCHIVE_INVALID')
  const wrapped = decodeBase64(header.wrappedMasterKey, 'wrappedMasterKey', 'ARCHIVE_INVALID')
  if (wrapped.length !== WRAPPED_KEY_LENGTH) {
    throw invalid('The wrapped master key has an invalid length.', {
      length: wrapped.length,
      expected: WRAPPED_KEY_LENGTH,
    })
  }
  return {
    header: buildHeader(header),
    headerBytes: Buffer.from(headerBytes),
    payloadOffset: headerBytes.length,
    sizeBytes,
    supported: true,
    raw,
  }
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buf, offset, length - offset, position + offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buf.subarray(0, offset)
}

/** Reads and validates the header of an open file without touching the payload. */
export async function readHeaderFromHandle(handle: FileHandle): Promise<ParsedHeader> {
  const stat = await handle.stat()
  if (!stat.isFile()) throw invalid('The path is not a regular file.')
  const prefix = await readExact(handle, FIXED_PREFIX_LENGTH, 0)
  if (prefix.length < FIXED_PREFIX_LENGTH) {
    throw invalid('The file is too short to be a .devbackup archive.', { sizeBytes: stat.size })
  }
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw invalid('Not a .devbackup archive (bad magic).')
  }
  const length = prefix.readUInt32BE(8)
  if (length < 2 || length > MAX_HEADER_JSON_LENGTH) {
    throw invalid('Invalid header length.', { length, max: MAX_HEADER_JSON_LENGTH })
  }
  const rest = await readExact(handle, length, FIXED_PREFIX_LENGTH)
  return parseHeaderBytes(Buffer.concat([prefix, rest]), stat.size)
}

/** Reads the unencrypted header. Newer format versions yield `supported: false` instead of throwing. */
export async function readDevBackupHeader(path: string): Promise<ReadHeaderResult> {
  let handle: FileHandle
  try {
    handle = await fs.open(path, 'r')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new MigrationError('PATH_NOT_FOUND', `Backup file not found: ${path}`, {
        details: { path },
      })
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new MigrationError('PERMISSION_DENIED', `Cannot read backup file: ${path}`, {
        details: { path },
      })
    }
    if (code === 'EISDIR') throw invalid('The path is a directory, not a backup file.', { path })
    throw new MigrationError('IO_ERROR', `Cannot open backup file: ${path}`, {
      details: { path },
      cause: err,
    })
  }
  try {
    const parsed = await readHeaderFromHandle(handle)
    return { header: parsed.header, sizeBytes: parsed.sizeBytes, supported: parsed.supported }
  } finally {
    await handle.close()
  }
}
