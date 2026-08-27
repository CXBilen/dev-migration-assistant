export { GitProvider, createGitProvider } from './git-provider'
export {
  GIT_PROVIDER_ID,
  GIT_SCHEMA_VERSION,
  RepositoryJson,
  WorktreeStateJson,
  GitArtifactMeta,
  PlanState,
  RestoreState,
} from './schema'
export type { WorktreeRecord, RemoteRecord } from './schema'
export {
  assertSafeArg,
  assertSafeBranchName,
  assertSha,
  checkGitAvailable,
  checkRefFormat,
  createGitClient,
  inspectRepository,
  isSafeRemoteUrl,
  isValidBranchName,
  isValidRemoteName,
  parseCountObjects,
  parseGitVersion,
  parseRemotes,
  parseStatusV2Lines,
  parseStatusV2Z,
  parseUpstreams,
  parseWorktreeList,
  quoteCPath,
  unquoteCPath,
} from './git'
export type { GitClient, GitVersion, StatusEntry, WorktreeListEntry } from './git'
export { worktreesOf, isJunkPath, slugForPath, parseSelection } from './common'
export type { WorktreeRef, GitSelection } from './common'
export { backupAsidePathFor, backupAsidePathsFrom } from './plan'
export { HOOK_GUARD_ARGS } from './restore'
export { DIFF_WARN_BYTES } from './backup'
