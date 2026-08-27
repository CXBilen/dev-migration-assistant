/**
 * Fixed constants of the .devbackup v1 container. Byte-exact documentation lives in
 * docs/backup-format/DEVBACKUP_SPEC.md — keep the two in sync.
 */
import type { ExtractionLimits, KdfParams } from './types'

/** ASCII magic at offset 0 (6 bytes). */
export const MAGIC_STRING = 'DEVBKP' as const
export const MAGIC = Buffer.from(MAGIC_STRING, 'ascii')
/** u16 BE at offset 6. Readers reject anything newer with ARCHIVE_UNSUPPORTED_VERSION. */
export const FORMAT_VERSION = 1
/** magic(6) + formatVersion(2) + headerJsonLength(4). */
export const FIXED_PREFIX_LENGTH = 12
/** Upper bound for headerJsonLength, enforced before any allocation. */
export const MAX_HEADER_JSON_LENGTH = 64 * 1024

/** Default plaintext bytes per AES-256-GCM chunk (ADR-0003). */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024
export const MIN_CHUNK_SIZE = 4096
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024

export const CIPHER_ALGORITHM = 'aes-256-gcm' as const
export const GCM_TAG_LENGTH = 16
export const GCM_NONCE_LENGTH = 12
export const MASTER_KEY_LENGTH = 32
export const KEK_LENGTH = 32
export const CONTENT_KEY_LENGTH = 32
export const SALT_LENGTH = 16
export const MIN_SALT_LENGTH = 8
export const MAX_SALT_LENGTH = 64
/** nonce(12) || ciphertext(32) || tag(16) */
export const WRAPPED_KEY_LENGTH = GCM_NONCE_LENGTH + MASTER_KEY_LENGTH + GCM_TAG_LENGTH

/** AAD of the master-key wrap. */
export const KEK_WRAP_AAD = Buffer.from('devbackup-kek-v1', 'utf8')
/** HKDF info of the content key. */
export const CONTENT_KEY_INFO = 'devbackup/content/v1'
/** Nonce = 11-byte big-endian counter || 1-byte last flag. */
export const CHUNK_COUNTER_BYTES = 11

/** KDF parameters without the salt (presets). */
export type KdfPreset = Omit<KdfParams, 'saltBase64'>

/** Strong preset used by every writer unless overridden: RFC 9106 "second recommended" option. */
export const DEFAULT_KDF_PARAMS: Readonly<KdfPreset> = Object.freeze({
  algorithm: 'argon2id',
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 4,
})

/** Fast preset for tests only. Equals the reader floor: files below it are rejected. */
export const FAST_KDF_PARAMS: Readonly<KdfPreset> = Object.freeze({
  algorithm: 'argon2id',
  memoryKiB: 8 * 1024,
  iterations: 1,
  parallelism: 1,
})

/** Bounds a reader accepts from an (untrusted) header before running the KDF. */
export const KDF_BOUNDS = Object.freeze({
  minMemoryKiB: FAST_KDF_PARAMS.memoryKiB,
  maxMemoryKiB: 1024 * 1024,
  minIterations: 1,
  maxIterations: 16,
  minParallelism: 1,
  maxParallelism: 16,
})

export const MANIFEST_ENTRY = 'manifest.json'
export const CHECKSUMS_ENTRY = 'checksums.json'
/** Hard caps for the two metadata entries that are buffered in memory. */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
export const MAX_CHECKSUMS_BYTES = 256 * 1024 * 1024

/** Suffix of the in-progress output file next to the final .devbackup. */
export const PARTIAL_SUFFIX = '.partial'
/** Suffix of per-file temp files during extraction; archive entries using it are rejected. */
export const EXTRACT_TEMP_SUFFIX = '.devmig-partial'
/** Default directory depth limit (segments) when ExtractionLimits.maxDepth is not set. */
export const DEFAULT_MAX_DEPTH = 128

export const DEFAULT_LIMITS_WITH_DEPTH: Readonly<Required<ExtractionLimits>> = Object.freeze({
  maxTotalBytes: 200 * 1024 ** 3,
  maxEntries: 2_000_000,
  maxEntryBytes: 50 * 1024 ** 3,
  maxPathLength: 1024,
  maxDepth: DEFAULT_MAX_DEPTH,
})

/** Throttle interval for onProgress callbacks. */
export const PROGRESS_INTERVAL_MS = 100
/** Read-side highWaterMark for the ciphertext file stream. */
export const READ_HIGH_WATER_MARK = 1024 * 1024
