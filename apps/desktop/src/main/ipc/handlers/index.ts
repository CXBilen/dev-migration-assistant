/**
 * Assembles the complete HandlerMap. The `HandlerMap` type lists every IpcChannels key exactly once,
 * so a missing or unknown channel is a compile error; the router additionally refuses duplicates.
 */
import type { HandlerMap, Router } from '../router'
import { backupHandlers } from './backups'
import type { HandlerDeps } from './deps'
import { jobHandlers } from './jobs'
import { projectHandlers } from './projects'
import { restoreHandlers } from './restore'
import { systemHandlers } from './system'

export type { HandlerDeps } from './deps'

export function buildHandlerMap(deps: HandlerDeps): HandlerMap {
  return {
    ...projectHandlers(deps),
    ...backupHandlers(deps),
    ...restoreHandlers(deps),
    ...jobHandlers(deps),
    ...systemHandlers(deps),
  }
}

/** Registers every channel from IpcChannels on the router. Returns the registered channel names. */
export function registerAllHandlers(router: Router, deps: HandlerDeps): string[] {
  return router.registerAll(buildHandlerMap(deps))
}
