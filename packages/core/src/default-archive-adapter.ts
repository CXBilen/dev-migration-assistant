/**
 * Default ArchiveAdapter: lazily imports `@devmig/archive` so the heavy crypto/tar code is only loaded
 * when a backup is actually created, inspected or restored.
 *
 * The module is accessed through a structural interface so that this file type-checks even while the
 * archive implementation is still being written; a missing export surfaces as a clear runtime error.
 */
import { MigrationError } from '@devmig/shared'
import type { ArchiveAdapter } from './archive-adapter'

type ArchiveModule = Partial<{
  createDevBackup: ArchiveAdapter['createDevBackup']
  readDevBackupHeader: ArchiveAdapter['readDevBackupHeader']
  inspectDevBackup: ArchiveAdapter['inspectDevBackup']
  extractDevBackup: ArchiveAdapter['extractDevBackup']
  verifyDevBackup: ArchiveAdapter['verifyDevBackup']
  computeChecksums: ArchiveAdapter['computeChecksums']
  writeChecksumsFile: ArchiveAdapter['writeChecksumsFile']
}>

let modulePromise: Promise<ArchiveModule> | undefined

async function loadArchive(): Promise<ArchiveModule> {
  modulePromise ??= import('@devmig/archive').then((m) => m as unknown as ArchiveModule)
  return modulePromise
}

async function member<K extends keyof ArchiveModule>(
  name: K,
): Promise<NonNullable<ArchiveModule[K]>> {
  const mod = await loadArchive()
  const fn = mod[name]
  if (typeof fn !== 'function') {
    throw new MigrationError(
      'ARCHIVE_INVALID',
      `The archive implementation does not export "${name}". This build of @devmig/archive is incomplete.`,
      { details: { missingExport: name } },
    )
  }
  return fn
}

export function createDefaultArchiveAdapter(): ArchiveAdapter {
  return {
    createDevBackup: async (opts) => (await member('createDevBackup'))(opts),
    readDevBackupHeader: async (path) => (await member('readDevBackupHeader'))(path),
    inspectDevBackup: async (opts) => (await member('inspectDevBackup'))(opts),
    extractDevBackup: async (opts) => (await member('extractDevBackup'))(opts),
    verifyDevBackup: async (opts) => (await member('verifyDevBackup'))(opts),
    computeChecksums: async (rootDir, opts) => (await member('computeChecksums'))(rootDir, opts),
    writeChecksumsFile: async (rootDir) => (await member('writeChecksumsFile'))(rootDir),
  }
}
