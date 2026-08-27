/**
 * Core service API consumed by the Electron main process (and by headless tests / CLI).
 * Implementations live in this package; the desktop app must depend on these interfaces only.
 */
import type {
  BackupHeaderInfo,
  BackupInspection,
  BackupRequest,
  BackupResult,
  Diagnostics,
  PathMapping,
  PathRemapReport,
  ProjectDescriptor,
  RestoreExecuteRequest,
  RestorePlan,
  RestorePlanRequest,
  RestoreResult,
  ScanSession,
} from '@devmig/model'
import type { Logger } from '@devmig/shared'
import type { Environment } from './environment'
import type { JobManager, JobRunContext } from './jobs/job-manager'
import type { ProviderRegistry } from './providers/registry'

export interface ScanOptions {
  includeGlobal: boolean
}

export interface ProjectScanner {
  /** Canonicalizes a user-selected directory into a ProjectDescriptor (git info populated when available). */
  describeProject(selectedPath: string, ctx: JobRunContext): Promise<ProjectDescriptor>
  /** Scans the selected directories with every registered provider. Read-only. */
  scan(paths: string[], options: ScanOptions, ctx: JobRunContext): Promise<ScanSession>
  /** Returns a previously produced scan session (kept in memory for the app lifetime). */
  getSession(scanId: string): ScanSession | undefined
}

export interface BackupPlanProjectEntry {
  project: ProjectDescriptor
  /** providerId -> selected artifacts for that provider (may be empty → provider skipped) */
  providers: Map<string, import('@devmig/model').ScannedArtifact[]>
}

export interface BackupPlan {
  scan: ScanSession
  projects: BackupPlanProjectEntry[]
  /** providerId -> selected global artifacts */
  global: Map<string, import('@devmig/model').ScannedArtifact[]>
  /** Sensitive artifacts explicitly included by the user (drives UI warnings and manifest flags). */
  includedSensitive: import('@devmig/model').ScannedArtifact[]
  estimatedBytes: number
  warnings: string[]
}

export interface MigrationPlanner {
  buildBackupPlan(scan: ScanSession, selectedArtifactIds: string[]): BackupPlan
}

export interface BackupEngine {
  /** Runs the whole backup pipeline (COLLECTING → PACKING → ENCRYPTING → VERIFYING). Never mutates sources. */
  run(request: BackupRequest, ctx: JobRunContext): Promise<BackupResult>
}

export interface RestoreEngine {
  readHeader(backupPath: string): Promise<BackupHeaderInfo>
  inspect(backupPath: string, password: string, ctx?: JobRunContext): Promise<BackupInspection>
  /** Dry-run remap analysis for the Restore Mapping screen (no writes). */
  previewRemap(backupPath: string, password: string, mappings: PathMapping[], ctx?: JobRunContext): Promise<PathRemapReport>
  /** Extracts to private staging, validates, runs provider planning + preflight. No destination writes. */
  plan(request: RestorePlanRequest, ctx: JobRunContext): Promise<RestorePlan>
  /** Executes an approved plan (kept in memory by id) and verifies. */
  execute(request: RestoreExecuteRequest, ctx: JobRunContext): Promise<RestoreResult>
  /** Streams through a backup verifying every chunk + checksum. */
  verify(backupPath: string, password: string, ctx: JobRunContext): Promise<{ ok: boolean; entries: number; bytes: number }>
  getPlan(planId: string): RestorePlan | undefined
  /** Removes staging directories for finished plans. Safe to call repeatedly. */
  cleanup(): Promise<void>
}

export interface CoreServices {
  env: Environment
  logger: Logger
  registry: ProviderRegistry
  jobs: JobManager
  scanner: ProjectScanner
  planner: MigrationPlanner
  backup: BackupEngine
  restore: RestoreEngine
  diagnostics(input: { appVersion: string; electronVersion: string | null; logsDirectory: string }): Promise<Diagnostics>
  /** Releases temp dirs; called on app quit. */
  dispose(): Promise<void>
}

export interface CreateCoreServicesOptions {
  env: Environment
  registry: ProviderRegistry
  appVersion: string
  /** Base dir for staging/temp (defaults to os.tmpdir()). Tests point this at a temp dir. */
  workDir?: string
}
