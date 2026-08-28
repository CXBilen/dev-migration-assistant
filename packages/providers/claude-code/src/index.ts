/**
 * @devmig/provider-claude-code — the flagship provider: Claude Code sessions, project memory,
 * checkpoints, prompt history, ~/.claude.json entries, project-side files and the user-wide
 * Claude Code environment. See docs/providers/claude-code.md.
 */
export {
  ClaudeCodeProvider,
  createClaudeCodeProvider,
  type ClaudeCodeProviderOptions,
} from './provider'
export {
  CLAUDE_CODE_DISPLAY_NAME,
  CLAUDE_CODE_PROVIDER_ID,
  CLAUDE_CODE_SCHEMA_VERSION,
  CLAUDE_JSON_GLOBAL_CONFIG_KEYS,
  CLAUDE_JSON_IDENTITY_KEYS,
  CLAUDE_PROJECT_DIR_MAX_LENGTH,
  EPHEMERAL_DIRS,
  PAYLOAD,
} from './constants'
export {
  ENCODING_RULE,
  encodeProjectDirName,
  verifyEncoding,
  type EncodedProjectDirName,
  type EncodingExample,
  type EncodingSample,
  type EncodingVerification,
} from './encoding'
export {
  PATH_BEARING_FIELDS,
  countPathFields,
  readJsonlLines,
  rewriteRecordPaths,
  rewriteTranscript,
  sampleTranscriptMetadata,
  type JsonlLine,
  type JsonRecord,
  type MapPath,
  type RewriteContext,
  type RewriteRecordResult,
  type RewriteTranscriptResult,
  type TranscriptMetadata,
  type UnsupportedReferenceRecord,
} from './transcript'
export {
  ClaudeProjectResolver,
  collectEncodingSamples,
  enumerateCandidates,
  matchCandidate,
  sessionIdFromFileName,
  type CandidateDir,
  type ClaudeMatchConfidence,
  type ClaudeMatchKind,
  type ClaudeProjectMatch,
  type MatchEvidence,
  type MatchOutcome,
  type ResolveContext,
  type ResolveResult,
} from './resolver'
export {
  applyMcpEnv,
  assertNoIdentityKeys,
  extractProjectEntries,
  extractUserScope,
  findMcpSecretHits,
  findProjectEntryKey,
  mergeAddOnly,
  readClaudeJson,
  stripMcpSecrets,
  type McpSecretHit,
} from './claude-json'
export {
  historyRowKey,
  historyRowMatchesPaths,
  isSamePathOrChild,
  readHistoryKeys,
  readHistoryRows,
} from './history'
export {
  findRunningClaudeSessions,
  defaultIsProcessAlive,
  type IsProcessAlive,
  type LiveSession,
} from './process'
export { copyFileAtomic, writeStreamAtomic } from './fs-helpers'
export {
  sanitizeTranscript,
  sanitizeTranscriptLine,
  createSanitizer,
  type SanitizeOptions,
  type Sanitizer,
} from './sanitize'
export {
  BackupIndexSchema,
  RestoreStateSchema,
  type BackupIndex,
  type RestoreState,
  type RestoreResultState,
} from './schema'
export { gitIgnoredPaths, globalArtifactId, projectArtifactId } from './scan'
