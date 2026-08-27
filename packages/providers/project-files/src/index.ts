export {
  PROJECT_FILES_PROVIDER_ID,
  PROJECT_FILES_PROVIDER_VERSION,
  PROJECT_FILES_SCHEMA_VERSION,
  ProjectFilesProvider,
  createProjectFilesProvider,
  resolveWorktreeRoots,
} from './project-files-provider'
export {
  CERT_DIRS,
  CERT_EXTENSIONS,
  CERT_MAX_DEPTH,
  ENV_TEMPLATE_SUFFIXES,
  KNOWN_ROOT_FILES,
  MAX_PROJECT_FILE_BYTES,
  categorizeRootFileName,
  categoryLabel,
  discoverCandidates,
  isCertFileName,
  isEnvFileName,
  isSafeRelpath,
} from './candidates'
export type { CandidateCategory, CandidateFile, DiscoverOptions } from './candidates'
export { checkIgnored, parseNulList, CHECK_IGNORE_TIMEOUT_MS } from './git-ignore'
export type { CheckIgnoreResult } from './git-ignore'
export {
  IndexEntry,
  ManifestFileMeta,
  PlanState,
  PlannedFile,
  ProjectFilesIndex,
  RestoreState,
  ScannedFileMeta,
  SkippedFile,
  WrittenFile,
} from './schema'
