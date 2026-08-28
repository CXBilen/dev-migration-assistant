/**
 * THE PROVIDER CONTRACT.
 *
 * A provider owns the migration semantics of one kind of development state
 * (Claude Code, Git, project files, runtime info, ...). Core orchestration must
 * never contain provider-specific hacks; providers must never write outside the
 * ScopedFs they are given.
 *
 * Lifecycle: detect -> scanProject / scanGlobal -> createBackupArtifacts
 *            -> planRestore -> restore -> verify   (+ optional remapPaths)
 *
 * Changing this file is an architectural decision owned by the principal agent.
 */
import type {
  Collision,
  CollisionPolicy,
  ManifestArtifact,
  ManifestProviderSection,
  PathMapping,
  PathRemapReport,
  PreflightCheck,
  ProjectDescriptor,
  ProviderRestoreOutcome,
  ProviderScanResult,
  RestoreStep,
  ScannedArtifact,
  VerificationCheck,
  AttentionItem,
} from '@devmig/model'
import type { Exec, Logger, ScopedFs } from '@devmig/shared'

export interface ProviderDetection {
  providerId: string
  available: boolean
  version?: string
  details: Record<string, string>
  notes: string[]
}

/** Environment facts shared by every context. */
export interface BaseContext {
  /** Home directory of the current user (tests override this). */
  homeDir: string
  /** Effective Claude config dir: $CLAUDE_CONFIG_DIR or <homeDir>/.claude. */
  claudeConfigDir: string
  /** Path of ~/.claude.json — inside claudeConfigDir when CLAUDE_CONFIG_DIR is set, else next to the home dir. */
  claudeJsonPath: string
  env: Record<string, string | undefined>
  exec: Exec
  logger: Logger
  signal: AbortSignal
  /** Report progress. `fraction` is optional; never fake it. */
  progress: (
    message: string,
    fraction?: number,
    item?: {
      id: string
      label: string
      status: 'pending' | 'running' | 'done' | 'warn' | 'failed' | 'skipped'
    },
  ) => void
}

export type DetectionContext = Omit<BaseContext, 'progress' | 'signal'> & { signal?: AbortSignal }

export interface ScanContext extends BaseContext {
  /** All selected projects — lets providers attribute worktree sessions etc. across the selection. */
  allProjects: ProjectDescriptor[]
}

export interface BackupContext extends BaseContext {
  /**
   * Provider-owned staging directory for this project (or for the global section):
   *   <stagingRoot>/projects/<projectId>/<providerId>/   or   <stagingRoot>/global/<providerId>/
   * Everything written here ends up in the payload. payloadPath in ManifestArtifact is relative to the payload root
   * (use `ctx.payloadPathFor(relativeInsideProviderDir)`).
   */
  stagingDir: string
  /** ScopedFs bound to the provider staging dir. Providers must write through this. */
  fs: ScopedFs
  /** Converts a path relative to `stagingDir` into a payload-root-relative POSIX path for the manifest. */
  payloadPathFor: (relativeInsideProviderDir: string) => string
  /** Private temp dir for intermediate files (git bundles etc.). Deleted after packing. */
  tempDir: string
}

export interface ProviderBackupInput {
  project?: ProjectDescriptor
  /** Only the artifacts the user selected for this provider. */
  artifacts: ScannedArtifact[]
  scan: ProviderScanResult
}

export interface ProviderBackupOutput {
  artifacts: ManifestArtifact[]
  /** Provider payload schema version written into the manifest. */
  schemaVersion: number
  summary?: Record<string, unknown>
  /** Provider-specific hints for restore (e.g. verified Claude dir-name encoding). No secrets. */
  restoreHints?: Record<string, unknown>
  warnings?: string[]
}

export interface RestorePlanningContext extends BaseContext {
  /** Root of the extracted (already validated) payload. Read-only. */
  payloadRoot: string
  mappings: PathMapping[]
  /** Resolves an old absolute path to its new location using the mappings (prefix-aware, worktree-aware). */
  mapPath: (oldPath: string) => { newPath: string; changed: boolean; mapped: boolean }
  defaultCollisionPolicy: CollisionPolicy
  restoreHints: Record<string, unknown>
}

export interface ProviderRestoreInput {
  project?: { id: string; name: string; oldPath: string; newPath: string }
  section: ManifestProviderSection
  /** Only the artifacts the user selected for restore. */
  artifacts: ManifestArtifact[]
}

export interface ProviderRestorePlan {
  providerId: string
  projectId?: string
  steps: RestoreStep[]
  collisions: Collision[]
  preflight: PreflightCheck[]
  remap: {
    affected: { label: string; count: number }[]
    safeRewriteCount: number
    warnings: string[]
    unsupportedReferences: { location: string; reason: string }[]
  }
  warnings: string[]
  /** Opaque provider data carried from planRestore to restore (paths, decisions). Serializable, no secrets. */
  state: Record<string, unknown>
}

export interface RestoreContext extends BaseContext {
  payloadRoot: string
  mappings: PathMapping[]
  mapPath: RestorePlanningContext['mapPath']
  /** ScopedFs whose roots are exactly the destinations approved in the plan (project newPath, claude config dir, etc.). */
  fs: ScopedFs
  /** Collision decisions keyed by collision id. */
  collisionDecisions: Record<string, CollisionPolicy>
  tempDir: string
}

export interface ProviderRestoreResult extends ProviderRestoreOutcome {
  attention?: AttentionItem[]
  /** Data needed by verify (e.g. expected git status). */
  state?: Record<string, unknown>
}

export interface VerifyContext extends BaseContext {
  payloadRoot: string
  mapPath: RestorePlanningContext['mapPath']
}

export interface ProviderVerifyInput {
  plan: ProviderRestorePlan
  result: ProviderRestoreResult
  input: ProviderRestoreInput
}

export interface ProviderVerification {
  checks: VerificationCheck[]
}

export interface RemapContext extends BaseContext {
  payloadRoot: string
}

export interface PathRemapResult {
  report: PathRemapReport
}

/**
 * Stable provider contract. Providers are registered explicitly (see registry.ts) — no giant switch statements.
 */
export interface MigrationProvider {
  readonly id: string
  readonly displayName: string
  /** Provider implementation version (semver-ish string for diagnostics). */
  readonly version: string
  /** Version of the payload layout this provider writes; bump on incompatible change. */
  readonly schemaVersion: number
  /** Whether the provider contributes a user-scoped ("global") section in addition to per-project results. */
  readonly supportsGlobal: boolean

  detect(ctx: DetectionContext): Promise<ProviderDetection>

  scanProject(project: ProjectDescriptor, ctx: ScanContext): Promise<ProviderScanResult>

  /** Scan user-scoped state. Only called when supportsGlobal is true. */
  scanGlobal?(ctx: ScanContext): Promise<ProviderScanResult>

  createBackupArtifacts(
    input: ProviderBackupInput,
    ctx: BackupContext,
  ): Promise<ProviderBackupOutput>

  planRestore(
    input: ProviderRestoreInput,
    ctx: RestorePlanningContext,
  ): Promise<ProviderRestorePlan>

  restore(
    plan: ProviderRestorePlan,
    input: ProviderRestoreInput,
    ctx: RestoreContext,
  ): Promise<ProviderRestoreResult>

  verify(input: ProviderVerifyInput, ctx: VerifyContext): Promise<ProviderVerification>

  /** Optional dry-run path remap analysis (used by the Restore Mapping screen before planning). */
  remapPaths?(
    mappings: PathMapping[],
    input: ProviderRestoreInput,
    ctx: RemapContext,
  ): Promise<PathRemapResult>
}
