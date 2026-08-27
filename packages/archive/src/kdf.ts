/**
 * Password → KEK with Argon2id (hash-wasm, pure WASM: no native module in Electron).
 * The call is CPU-bound and blocks the calling thread for the duration (≈0.1–1 s with the default preset).
 */
import { argon2id } from 'hash-wasm'
import { MigrationError, throwIfAborted } from '@devmig/shared'
import type { ErrorCode } from '@devmig/model'
import {
  DEFAULT_KDF_PARAMS,
  KDF_BOUNDS,
  KEK_LENGTH,
  MAX_SALT_LENGTH,
  MIN_SALT_LENGTH,
  type KdfPreset,
} from './constants'
import type { KdfParams } from './types'

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Strict base64 decode: rejects garbage instead of silently truncating. */
export function decodeBase64(value: string, field: string, code: ErrorCode): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !BASE64_RE.test(value)
  ) {
    throw new MigrationError(code, `Invalid base64 in header field "${field}".`, {
      details: { field },
    })
  }
  const buf = Buffer.from(value, 'base64')
  if (buf.toString('base64') !== value) {
    throw new MigrationError(code, `Invalid base64 in header field "${field}".`, {
      details: { field },
    })
  }
  return buf
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/**
 * Validates KDF parameters against the accepted bounds. Readers call this with the header's
 * (untrusted) values before running Argon2id so a hostile file cannot demand gigabytes of RAM.
 * Returns the decoded salt.
 */
export function validateKdfParams(kdf: KdfParams, code: ErrorCode = 'ARCHIVE_INVALID'): Buffer {
  const fail = (msg: string, details?: Record<string, unknown>): never => {
    throw new MigrationError(code, msg, { details })
  }
  if (kdf.algorithm !== 'argon2id') fail(`Unsupported KDF algorithm: ${String(kdf.algorithm)}`)
  if (
    !isInt(kdf.memoryKiB) ||
    kdf.memoryKiB < KDF_BOUNDS.minMemoryKiB ||
    kdf.memoryKiB > KDF_BOUNDS.maxMemoryKiB
  ) {
    fail(
      `KDF memory must be between ${KDF_BOUNDS.minMemoryKiB} and ${KDF_BOUNDS.maxMemoryKiB} KiB.`,
      { memoryKiB: kdf.memoryKiB },
    )
  }
  if (
    !isInt(kdf.iterations) ||
    kdf.iterations < KDF_BOUNDS.minIterations ||
    kdf.iterations > KDF_BOUNDS.maxIterations
  ) {
    fail(
      `KDF iterations must be between ${KDF_BOUNDS.minIterations} and ${KDF_BOUNDS.maxIterations}.`,
      { iterations: kdf.iterations },
    )
  }
  if (
    !isInt(kdf.parallelism) ||
    kdf.parallelism < KDF_BOUNDS.minParallelism ||
    kdf.parallelism > KDF_BOUNDS.maxParallelism
  ) {
    fail(
      `KDF parallelism must be between ${KDF_BOUNDS.minParallelism} and ${KDF_BOUNDS.maxParallelism}.`,
      { parallelism: kdf.parallelism },
    )
  }
  if (kdf.memoryKiB < 8 * kdf.parallelism) {
    fail('KDF memory must be at least 8 KiB per lane.', {
      memoryKiB: kdf.memoryKiB,
      parallelism: kdf.parallelism,
    })
  }
  const salt = decodeBase64(kdf.saltBase64, 'kdf.saltBase64', code)
  if (salt.length < MIN_SALT_LENGTH || salt.length > MAX_SALT_LENGTH) {
    fail(`KDF salt must be between ${MIN_SALT_LENGTH} and ${MAX_SALT_LENGTH} bytes.`, {
      saltLength: salt.length,
    })
  }
  return salt
}

/** Merges a writer-side override onto the strong default preset. */
export function resolveKdfPreset(override?: Partial<KdfPreset>): KdfPreset {
  return {
    algorithm: 'argon2id',
    memoryKiB: override?.memoryKiB ?? DEFAULT_KDF_PARAMS.memoryKiB,
    iterations: override?.iterations ?? DEFAULT_KDF_PARAMS.iterations,
    parallelism: override?.parallelism ?? DEFAULT_KDF_PARAMS.parallelism,
  }
}

export interface DeriveKeyOptions {
  signal?: AbortSignal
  /** Error code used when the parameters are out of bounds (ARCHIVE_INVALID for readers, INVALID_INPUT for writers). */
  boundsErrorCode?: ErrorCode
}

/**
 * Derives the 32-byte key-encryption key from a password with Argon2id.
 * The password is NFC-normalised so the same characters typed on two Macs yield the same key.
 */
export async function deriveKeyFromPassword(
  password: string,
  kdf: KdfParams,
  options: DeriveKeyOptions = {},
): Promise<Buffer> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new MigrationError('INVALID_INPUT', 'A password is required.')
  }
  const salt = validateKdfParams(kdf, options.boundsErrorCode ?? 'ARCHIVE_INVALID')
  throwIfAborted(options.signal)
  const key = await argon2id({
    password: Buffer.from(password.normalize('NFC'), 'utf8'),
    salt,
    memorySize: kdf.memoryKiB,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    hashLength: KEK_LENGTH,
    outputType: 'binary',
  })
  throwIfAborted(options.signal)
  return Buffer.from(key.buffer, key.byteOffset, key.byteLength)
}
