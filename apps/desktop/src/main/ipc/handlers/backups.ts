import { MigrationError } from '@devmig/shared'
import type { HandlerMap } from '../router'
import { validateReadPath } from '../../services/destinations'
import type { HandlerDeps } from './deps'

export type BackupHandlers = Pick<
  HandlerMap,
  | 'backups:selectOutputPath'
  | 'backups:create'
  | 'backups:selectFile'
  | 'backups:readHeader'
  | 'backups:inspect'
  | 'backups:verify'
>

export function backupHandlers(deps: HandlerDeps): BackupHandlers {
  const { core, dialogs, system, approved } = deps
  const homeDir = core.env.homeDir

  return {
    'backups:selectOutputPath': async (input, ctx) => {
      const { defaultDirectory } = await system.suggestBackupName()
      const result = await dialogs.selectOutputPath(
        ctx.window,
        input.suggestedName,
        defaultDirectory,
      )
      if (result.path) approved.approve(result.path)
      return result
    },

    'backups:create': (input) => {
      // The renderer may only echo an output path the user picked in the Save dialog.
      const outputPath = validateReadPath(input.outputPath, homeDir, 'Output path')
      if (!approved.has(outputPath)) {
        throw new MigrationError(
          'PERMISSION_DENIED',
          'The backup location was not chosen through the Save dialog.',
          { hint: 'Use Choose… to pick where the backup is saved.', details: { outputPath } },
        )
      }
      const snapshot = core.jobs.start(
        'backup',
        (job) => core.backup.run({ ...input, outputPath }, job),
        'COLLECTING',
      )
      return { jobId: snapshot.id }
    },

    'backups:selectFile': async (_input, ctx) => {
      const result = await dialogs.selectBackupFile(ctx.window)
      if (result.path) approved.approve(result.path)
      return result
    },

    'backups:readHeader': (input) =>
      core.restore.readHeader(validateReadPath(input.path, homeDir, 'Backup path')),

    'backups:inspect': (input) =>
      core.restore.inspect(validateReadPath(input.path, homeDir, 'Backup path'), input.password),

    'backups:verify': (input) => {
      const backupPath = validateReadPath(input.path, homeDir, 'Backup path')
      const snapshot = core.jobs.start(
        'verify',
        (job) => core.restore.verify(backupPath, input.password, job),
        'INSPECT',
      )
      return { jobId: snapshot.id }
    },
  }
}
