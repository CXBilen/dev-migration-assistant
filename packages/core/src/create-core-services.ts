/**
 * Wires the engines together. The Electron main process (and headless tests) call this once.
 */
import os from 'node:os'
import path from 'node:path'
import type { CoreServices, CreateCoreServicesOptions } from './api'
import type { ArchiveAdapter } from './archive-adapter'
import { DefaultBackupEngine } from './backup/backup-engine'
import { createDefaultArchiveAdapter } from './default-archive-adapter'
import { collectDiagnostics } from './diagnostics'
import { JobManager } from './jobs/job-manager'
import { DefaultMigrationPlanner } from './migration/planner'
import { DefaultRestoreEngine } from './restore/restore-engine'
import { DefaultProjectScanner } from './scan/project-scanner'

export interface CreateCoreServicesExtras {
  /** Container implementation; defaults to a lazy import of `@devmig/archive`. Tests inject a fake. */
  archive?: ArchiveAdapter
}

export function defaultWorkDir(): string {
  return path.join(os.tmpdir(), 'devmig')
}

export function createCoreServices(
  options: CreateCoreServicesOptions & CreateCoreServicesExtras,
): CoreServices {
  const { env, registry, appVersion } = options
  const logger = env.logger
  const workDir = options.workDir ?? defaultWorkDir()
  const archive = options.archive ?? createDefaultArchiveAdapter()
  const jobs = new JobManager(logger)
  const scanner = new DefaultProjectScanner({ env, registry })
  const planner = new DefaultMigrationPlanner()
  const backup = new DefaultBackupEngine({
    env,
    registry,
    scanner,
    planner,
    archive,
    appVersion,
    workDir,
  })
  const restore = new DefaultRestoreEngine({ env, registry, archive, workDir })
  return {
    env,
    logger,
    registry,
    jobs,
    scanner,
    planner,
    backup,
    restore,
    diagnostics: (input) => collectDiagnostics(env, registry, input),
    dispose: async () => {
      await restore.dispose()
    },
  }
}
