import type { CoreServices } from '@devmig/core'
import type { Logger } from '@devmig/shared'
import type { ApprovedPaths } from '../../services/approved-paths'
import type { DialogService } from '../../services/dialogs'
import type { SystemService } from '../../services/system'

/** Everything the channel handlers need. Built once in main/index.ts. */
export interface HandlerDeps {
  core: CoreServices
  dialogs: DialogService
  system: SystemService
  approved: ApprovedPaths
  logger: Logger
  /** Extra write roots accepted for restore destinations (E2E fixture roots under the OS temp dir). */
  extraDestinationRoots?: readonly string[]
}
