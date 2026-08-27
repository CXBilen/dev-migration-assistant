import { Manifest as ManifestSchema, type Manifest } from '@devmig/model'
import { MigrationError } from '@devmig/shared'
import { FORMAT_VERSION } from './constants'
import { invalid } from './errors'
import type { DevBackupHeader } from './types'

/** Parses + zod-validates manifest.json from the payload and ties it to the header. */
export function parseManifest(data: Buffer, header: DevBackupHeader): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(data.toString('utf8')) as unknown
  } catch {
    throw new MigrationError('MANIFEST_INVALID', 'manifest.json is not valid JSON.')
  }
  const parsed = ManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new MigrationError(
      'MANIFEST_INVALID',
      'manifest.json does not match the expected schema.',
      {
        details: {
          issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`),
        },
      },
    )
  }
  const manifest = parsed.data
  if (manifest.formatVersion > FORMAT_VERSION) {
    throw new MigrationError(
      'ARCHIVE_UNSUPPORTED_VERSION',
      `The manifest declares format version ${manifest.formatVersion}, which this app cannot read.`,
      { details: { formatVersion: manifest.formatVersion } },
    )
  }
  if (manifest.formatVersion !== header.formatVersion) {
    throw invalid('The manifest format version does not match the container header.', {
      manifest: manifest.formatVersion,
      header: header.formatVersion,
    })
  }
  if (manifest.id !== header.backupId) {
    throw invalid('The manifest id does not match the container header.', {
      manifestId: manifest.id,
      backupId: header.backupId,
    })
  }
  return manifest
}
