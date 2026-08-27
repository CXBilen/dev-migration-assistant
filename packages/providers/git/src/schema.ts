/**
 * zod schemas for everything the provider reads back from untrusted input: artifact meta carried
 * through the manifest, the payload files it wrote at backup time (repository.json, state.json),
 * and the opaque plan/result state carried between planRestore -> restore -> verify.
 */
import { z } from 'zod'

export const GIT_PROVIDER_ID = 'git'
export const GIT_SCHEMA_VERSION = 1

export const REPOSITORY_JSON = 'repository.json'
export const BUNDLE_FILE = 'repo.bundle'
export const WORKTREES_DIR = 'worktrees'
export const STATE_JSON = 'state.json'
export const STAGED_DIFF = 'staged.diff'
export const UNSTAGED_DIFF = 'unstaged.diff'
export const UNTRACKED_DIR = 'untracked'
export const UNTRACKED_SENSITIVE_DIR = 'untracked-sensitive'
export const IGNORED_DIR = 'ignored'
export const UNAPPLIED_DIR = '.devmig-unapplied'

const NullableString = z.string().nullable()
const Index = z.number().int().nonnegative()

const MetaBase = z.object({
  /** Payload-relative POSIX path of repository.json (set at backup time). */
  repositoryJson: z.string().optional(),
})

export const BundleMeta = MetaBase.extend({
  kind: z.literal('bundle'),
  primaryPath: z.string(),
})
export const WorktreeStateMeta = MetaBase.extend({
  kind: z.literal('worktree-state'),
  worktreeIndex: Index,
  path: z.string(),
  isPrimary: z.boolean(),
  branch: NullableString,
  head: NullableString,
  detached: z.boolean(),
  relativeToPrimary: z.string().optional(),
})
export const UntrackedSensitiveMeta = MetaBase.extend({
  kind: z.literal('untracked-sensitive'),
  worktreeIndex: Index,
  path: z.string(),
  paths: z.array(z.string()),
})
export const IgnoredMeta = MetaBase.extend({
  kind: z.literal('ignored'),
  worktreeIndex: Index,
  path: z.string(),
  relPath: z.string(),
  isDirectory: z.boolean(),
  slug: z.string(),
})
export const JunkMeta = MetaBase.extend({
  kind: z.literal('junk'),
  worktreeIndex: Index,
  relPath: z.string(),
})

export const GitArtifactMeta = z.discriminatedUnion('kind', [
  BundleMeta,
  WorktreeStateMeta,
  UntrackedSensitiveMeta,
  IgnoredMeta,
  JunkMeta,
])
export type GitArtifactMeta = z.infer<typeof GitArtifactMeta>
export type BundleMeta = z.infer<typeof BundleMeta>
export type WorktreeStateMeta = z.infer<typeof WorktreeStateMeta>
export type UntrackedSensitiveMeta = z.infer<typeof UntrackedSensitiveMeta>
export type IgnoredMeta = z.infer<typeof IgnoredMeta>

export const RemoteRecord = z.object({
  name: z.string(),
  fetchUrl: z.string(),
  pushUrl: z.string().optional(),
})
export type RemoteRecord = z.infer<typeof RemoteRecord>

export const UpstreamRecord = z.object({
  remote: z.string().optional(),
  merge: z.string().optional(),
})

export const WorktreeRecord = z.object({
  index: Index,
  path: z.string(),
  branch: NullableString,
  head: NullableString,
  detached: z.boolean(),
  isPrimary: z.boolean(),
  relativeToPrimary: z.string().optional(),
  locked: z.boolean().default(false),
  prunable: z.boolean().default(false),
  /** True when a worktrees/<index>/ state directory was written for this worktree. */
  captured: z.boolean().default(false),
})
export type WorktreeRecord = z.infer<typeof WorktreeRecord>

/** repository.json — written at the root of the provider staging dir on every backup. */
export const RepositoryJson = z.object({
  schemaVersion: z.literal(GIT_SCHEMA_VERSION),
  capturedAt: z.string(),
  gitVersion: NullableString,
  primaryPath: z.string(),
  commonDir: NullableString,
  head: NullableString,
  branch: NullableString,
  detached: z.boolean(),
  bundle: z.object({
    included: z.boolean(),
    file: NullableString,
    sizeBytes: z.number().int().nonnegative(),
  }),
  remotes: z.array(RemoteRecord),
  upstreams: z.record(z.string(), UpstreamRecord),
  worktrees: z.array(WorktreeRecord),
  stashCount: z.number().int().nonnegative().default(0),
  hasSubmodules: z.boolean().default(false),
})
export type RepositoryJson = z.infer<typeof RepositoryJson>

const DiffRecord = z.object({
  file: z.string(),
  bytes: z.number().int().nonnegative(),
  empty: z.boolean(),
})

/** worktrees/<n>/state.json */
export const WorktreeStateJson = z.object({
  schemaVersion: z.literal(GIT_SCHEMA_VERSION),
  worktreeIndex: Index,
  path: z.string(),
  isPrimary: z.boolean(),
  branch: NullableString,
  head: NullableString,
  detached: z.boolean(),
  relativeToPrimary: z.string().optional(),
  /** Sorted lines of `git -c core.quotepath=false status --porcelain=v2 --untracked-files=all`. */
  statusLines: z.array(z.string()),
  stagedPaths: z.array(z.string()),
  unstagedPaths: z.array(z.string()),
  conflictedPaths: z.array(z.string()),
  /** Untracked files copied under untracked/. */
  untrackedPaths: z.array(z.string()),
  /** Sensitive untracked files (copied under untracked-sensitive/ only when sensitiveIncluded). */
  sensitiveUntrackedPaths: z.array(z.string()),
  sensitiveIncluded: z.boolean(),
  /** Untracked entries never captured (credentials, symlinks, nested repositories, unreadable). */
  excludedUntrackedPaths: z.array(z.string()),
  stagedDiff: DiffRecord,
  unstagedDiff: DiffRecord,
})
export type WorktreeStateJson = z.infer<typeof WorktreeStateJson>

export const PlanWorktree = z.object({
  index: Index,
  oldPath: z.string(),
  newPath: z.string(),
  branch: NullableString,
  head: NullableString,
  detached: z.boolean(),
  isPrimary: z.boolean(),
  /** Absolute path of worktrees/<n>/ inside the payload, or null when the state artifact was not selected. */
  stateDir: NullableString,
  includeSensitive: z.boolean(),
  collisionId: NullableString,
  /** Sibling path the existing worktree directory is moved to under backup-then-replace (computed at plan time). */
  backupAsidePath: z.string().optional(),
  /** Set when planning already decided the worktree cannot be recreated (e.g. branch used twice). */
  skipReason: z.string().optional(),
})
export type PlanWorktree = z.infer<typeof PlanWorktree>

export const PlanIgnored = z.object({
  worktreeIndex: Index,
  relPath: z.string(),
  isDirectory: z.boolean(),
  /** Absolute path inside the payload. */
  payloadPath: z.string(),
  label: z.string(),
})
export type PlanIgnored = z.infer<typeof PlanIgnored>

/** Opaque state carried from planRestore to restore. */
export const PlanState = z.object({
  destination: z.string(),
  repositoryJson: z.string(),
  bundlePath: NullableString,
  restoreBundle: z.boolean(),
  emptyRepository: z.boolean(),
  primaryBranch: NullableString,
  head: NullableString,
  detached: z.boolean(),
  remotes: z.array(RemoteRecord),
  upstreams: z.record(z.string(), UpstreamRecord),
  worktrees: z.array(PlanWorktree),
  ignored: z.array(PlanIgnored),
  destinationCollisionId: NullableString,
  backupAsidePath: z.string(),
})
export type PlanState = z.infer<typeof PlanState>

export const RestoredWorktree = z.object({
  index: Index,
  newPath: z.string(),
  isPrimary: z.boolean(),
  created: z.boolean(),
  stateDir: NullableString,
  stateApplied: z.boolean(),
  applyFailed: z.boolean(),
  sensitiveRestored: z.boolean(),
  expectedHead: NullableString,
  expectedBranch: NullableString,
  expectedDetached: z.boolean(),
})
export type RestoredWorktree = z.infer<typeof RestoredWorktree>

/** Opaque state carried from restore to verify. */
export const RestoreState = z.object({
  destination: z.string(),
  skipped: z.boolean(),
  worktrees: z.array(RestoredWorktree),
  remotes: z.array(RemoteRecord),
})
export type RestoreState = z.infer<typeof RestoreState>
