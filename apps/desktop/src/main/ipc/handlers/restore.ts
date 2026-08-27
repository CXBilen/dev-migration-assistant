import type { PathMapping } from '@devmig/model'
import type { HandlerMap } from '../router'
import { validateDestinationPath, validateReadPath } from '../../services/destinations'
import type { HandlerDeps } from './deps'

export type RestoreHandlers = Pick<
  HandlerMap,
  'restore:selectDestination' | 'restore:previewRemap' | 'restore:plan' | 'restore:execute'
>

export function restoreHandlers(deps: HandlerDeps): RestoreHandlers {
  const { core, dialogs, approved } = deps
  const homeDir = core.env.homeDir

  /** Old paths are data from the manifest (validated later against it); new paths are write destinations. */
  const validateMappings = (mappings: PathMapping[]): PathMapping[] =>
    mappings.map((m) => ({
      projectId: m.projectId,
      oldPath: validateReadPath(m.oldPath, homeDir, 'Previous path'),
      newPath: validateDestinationPath(
        m.newPath,
        { homeDir, approved, extraRoots: deps.extraDestinationRoots },
        'Restore location',
      ),
    }))

  return {
    'restore:selectDestination': async (input, ctx) => {
      const result = await dialogs.selectDestination(ctx.window, {
        ...(input.title ? { title: input.title } : {}),
        ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
      })
      if (result.path) approved.approve(result.path)
      return result
    },

    'restore:previewRemap': async (input) =>
      core.restore.previewRemap(
        validateReadPath(input.path, homeDir, 'Backup path'),
        input.password,
        validateMappings(input.mappings),
      ),

    'restore:plan': (input) => {
      const request = {
        ...input,
        backupPath: validateReadPath(input.backupPath, homeDir, 'Backup path'),
        mappings: validateMappings(input.mappings),
      }
      const snapshot = core.jobs.start(
        'restore-plan',
        (job) => core.restore.plan(request, job),
        'INSPECT',
      )
      return { jobId: snapshot.id }
    },

    'restore:execute': (input) => {
      const snapshot = core.jobs.start(
        'restore',
        (job) => core.restore.execute(input, job),
        'STAGE',
      )
      return { jobId: snapshot.id }
    },
  }
}
