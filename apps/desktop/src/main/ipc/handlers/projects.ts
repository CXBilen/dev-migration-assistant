import { MigrationError } from '@devmig/shared'
import type { HandlerMap } from '../router'
import { validateReadPath } from '../../services/destinations'
import type { HandlerDeps } from './deps'

export type ProjectHandlers = Pick<HandlerMap, 'projects:selectDirectories' | 'projects:scan'>

export function projectHandlers(deps: HandlerDeps): ProjectHandlers {
  const { core, dialogs, approved } = deps
  return {
    'projects:selectDirectories': async (input, ctx) => {
      const result = await dialogs.selectDirectories(ctx.window, {
        ...(input.title ? { title: input.title } : {}),
        ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
      })
      for (const p of result.paths) approved.approve(p)
      return result
    },

    'projects:scan': (input) => {
      const paths = input.paths.map((p) => validateReadPath(p, core.env.homeDir, 'Project path'))
      const unique = [...new Set(paths)]
      if (unique.length === 0) {
        throw new MigrationError('INVALID_INPUT', 'Select at least one project folder.')
      }
      const snapshot = core.jobs.start(
        'scan',
        (job) => core.scanner.scan(unique, { includeGlobal: input.includeGlobal }, job),
        'DISCOVERING',
      )
      return { jobId: snapshot.id }
    },
  }
}
