/** Identity and payload-layout constants of the Claude Code provider. */
export const CLAUDE_CODE_PROVIDER_ID = 'claude-code'
export const CLAUDE_CODE_DISPLAY_NAME = 'Claude Code'
export const CLAUDE_CODE_PROVIDER_VERSION = '0.1.0'
/** Payload layout version written by createBackupArtifacts (see docs/providers/claude-code.md). */
export const CLAUDE_CODE_SCHEMA_VERSION = 1

/** Relative payload layout inside the provider staging directory. */
export const PAYLOAD = {
  index: 'index.json',
  sessions: 'sessions',
  memory: 'memory',
  fileHistory: 'file-history',
  sessionEnv: 'session-env',
  history: 'history.jsonl',
  claudeJson: 'claude-json.json',
  projectFiles: 'project-files',
  settings: 'settings',
  claudeMd: 'claude-md',
  skills: 'skills',
  agents: 'agents',
  outputStyles: 'output-styles',
  commands: 'commands',
  themes: 'themes',
  statusline: 'statusline',
  plugins: 'plugins',
  userClaudeJson: 'claude-json-user.json',
  userMcpEnv: 'claude-json-user-mcp-env.json',
} as const

/** Global config keys of ~/.claude.json that Claude Code reads only from that file (settings-reference). */
export const CLAUDE_JSON_GLOBAL_CONFIG_KEYS = [
  'autoConnectIde',
  'autoInstallIdeExtension',
  'diffTool',
  'externalEditorContext',
  'permissionExplainerEnabled',
  'teammateDefaultModel',
] as const

/** Keys of ~/.claude.json that identify the account/machine and are never migrated. */
export const CLAUDE_JSON_IDENTITY_KEYS = ['oauthAccount', 'userID', 'machineID'] as const

/** Directories under the Claude config dir that are machine-local and never migrated. */
export const EPHEMERAL_DIRS = [
  'sessions',
  'shell-snapshots',
  'security',
  'telemetry',
  'cache',
  'ide',
  'paste-cache',
  'backups',
  'debug',
  'tasks',
  'plans',
  'image-cache',
  'uploads',
  'todos',
  'statsig',
  'logs',
  'usage-data',
  'feedback-bundles',
  'downloads',
] as const

/** Maximum encoded project directory name length before Claude Code truncates and appends a hash. */
export const CLAUDE_PROJECT_DIR_MAX_LENGTH = 200

/** Records sampled from a transcript when collecting evidence (cwd, version, ...). */
export const DEFAULT_SAMPLE_RECORDS = 200
/** Transcripts sampled per candidate project directory when resolving matches. */
export const MAX_SAMPLED_TRANSCRIPTS_PER_DIR = 5
/** Upper bound for files walked under <project>/.claude when looking for project-side files. */
export const MAX_PROJECT_CLAUDE_FILES = 2_000
/** Upper bound for records scanned while estimating the remap report. */
export const MAX_REMAP_ESTIMATE_RECORDS = 50_000
