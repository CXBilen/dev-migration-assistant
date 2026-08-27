import type { HandlerMap } from '../router'
import type { HandlerDeps } from './deps'

export type SystemHandlers = Pick<
  HandlerMap,
  | 'system:openInFinder'
  | 'system:openInTerminal'
  | 'system:openExternal'
  | 'system:diagnostics'
  | 'system:copyDiagnostics'
  | 'system:openLogs'
  | 'system:suggestBackupName'
  | 'system:homeDir'
  | 'system:pathExists'
>

export function systemHandlers(deps: HandlerDeps): SystemHandlers {
  const { system } = deps
  return {
    'system:openInFinder': (input) => system.openInFinder(input.path),
    'system:openInTerminal': (input) => system.openInTerminal(input.path),
    'system:openExternal': (input) => system.openExternal(input.url),
    'system:diagnostics': () => system.diagnostics(),
    'system:copyDiagnostics': () => system.copyDiagnostics(),
    'system:openLogs': () => system.openLogs(),
    'system:suggestBackupName': () => system.suggestBackupName(),
    'system:homeDir': () => system.homeDir(),
    'system:pathExists': (input) => system.pathExists(input.path),
  }
}
