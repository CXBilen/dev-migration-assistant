/**
 * Injection seam between the core engines and the `.devbackup` container implementation.
 * The shape mirrors the public exports of `@devmig/archive` exactly so the default adapter is a thin
 * pass-through, while tests can substitute an in-memory / temp-dir fake.
 */
import type {
  CreateDevBackupOptions,
  CreateDevBackupResult,
  ExtractDevBackupOptions,
  ExtractDevBackupResult,
  InspectDevBackupOptions,
  InspectDevBackupResult,
  ReadHeaderResult,
  VerifyDevBackupOptions,
  VerifyDevBackupResult,
} from '@devmig/archive'
import type { Checksums } from '@devmig/model'

export interface ComputeChecksumsOptions {
  signal?: AbortSignal
}

export interface ArchiveAdapter {
  createDevBackup(opts: CreateDevBackupOptions): Promise<CreateDevBackupResult>
  readDevBackupHeader(path: string): Promise<ReadHeaderResult>
  inspectDevBackup(opts: InspectDevBackupOptions): Promise<InspectDevBackupResult>
  extractDevBackup(opts: ExtractDevBackupOptions): Promise<ExtractDevBackupResult>
  verifyDevBackup(opts: VerifyDevBackupOptions): Promise<VerifyDevBackupResult>
  /** Streams every file under rootDir through SHA-256 (checksums.json itself excluded). */
  computeChecksums(rootDir: string, opts?: ComputeChecksumsOptions): Promise<Checksums>
  /** Computes checksums for rootDir and writes `<rootDir>/checksums.json`. */
  writeChecksumsFile(rootDir: string): Promise<Checksums>
}
