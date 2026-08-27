/**
 * Public API surface of the .devbackup container. Implementation lives in this package (Phase 5).
 * See docs/backup-format/DEVBACKUP_SPEC.md for the byte layout.
 */
import type { Checksums, Manifest } from '@devmig/model'

export interface KdfParams {
  algorithm: 'argon2id'
  memoryKiB: number
  iterations: number
  parallelism: number
  saltBase64: string
}

/** Unencrypted, authenticated header. Contains nothing sensitive beyond KDF parameters. */
export interface DevBackupHeader {
  magic: 'DEVBKP'
  formatVersion: number
  cipher: 'aes-256-gcm'
  chunkSize: number
  kdf: KdfParams
  /** Master key wrapped with the password-derived KEK (AES-256-GCM: nonce||ciphertext||tag), base64. */
  wrappedMasterKey: string
  createdAt: string
  /** Opaque id matching manifest.id so a header can be matched to its manifest without decrypting. */
  backupId: string
  appVersion: string
}

export interface ArchiveProgress {
  /** Payload bytes processed so far (plaintext side). */
  bytes: number
  /** Total plaintext bytes when known. */
  totalBytes?: number
  entries: number
  message?: string
}

export interface ExtractionLimits {
  /** Max total plaintext bytes to extract (decompression-bomb guard). */
  maxTotalBytes: number
  maxEntries: number
  maxEntryBytes: number
  maxPathLength: number
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxTotalBytes: 200 * 1024 ** 3,
  maxEntries: 2_000_000,
  maxEntryBytes: 50 * 1024 ** 3,
  maxPathLength: 1024,
}

export interface CreateDevBackupOptions {
  /** Directory whose contents become the payload (manifest.json must exist at its root). */
  sourceDir: string
  outputPath: string
  password: string
  manifest: Manifest
  signal?: AbortSignal
  onProgress?: (p: ArchiveProgress) => void
  /** Override KDF cost (tests use low values). */
  kdf?: Partial<Omit<KdfParams, 'algorithm' | 'saltBase64'>>
  chunkSize?: number
}

export interface CreateDevBackupResult {
  outputPath: string
  sizeBytes: number
  payloadBytes: number
  entries: number
  checksums: Checksums
}

export interface ReadHeaderResult {
  header: DevBackupHeader
  sizeBytes: number
  supported: boolean
}

export interface InspectDevBackupOptions {
  path: string
  password: string
  signal?: AbortSignal
}

export interface InspectDevBackupResult {
  header: DevBackupHeader
  manifest: Manifest
  sizeBytes: number
}

export interface ExtractDevBackupOptions {
  path: string
  password: string
  destinationDir: string
  signal?: AbortSignal
  onProgress?: (p: ArchiveProgress) => void
  limits?: Partial<ExtractionLimits>
  /** Verify checksums.json against extracted files (default true). */
  verifyChecksums?: boolean
}

export interface ExtractDevBackupResult {
  header: DevBackupHeader
  manifest: Manifest
  entries: number
  bytes: number
  checksumsVerified: boolean
}

export interface VerifyDevBackupOptions {
  path: string
  password: string
  signal?: AbortSignal
  onProgress?: (p: ArchiveProgress) => void
}

export interface VerifyDevBackupResult {
  header: DevBackupHeader
  manifest: Manifest
  entries: number
  bytes: number
  /** Every chunk authenticated and every checksums.json entry matched the streamed content. */
  ok: true
}
