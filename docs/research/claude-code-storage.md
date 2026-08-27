# Claude Code local storage: where state lives and how to migrate it

Research doc for Dev Migration Assistant. Compiled 2026-08-27 against the official
Claude Code docs (fetched that day) and a read-only inspection of one macOS machine
running **Claude Code 2.1.247** (native install). Real usernames are written as `<user>`.

Provenance markers used below:

- **[docs]** — stated by the official documentation; the URL follows the claim.
- **[observed]** — seen on the inspected machine (2.1.247, macOS 26.6). Treat as
  version-specific evidence, not a contract; the JSONL entry format is explicitly
  documented as internal and subject to change between releases
  (https://code.claude.com/docs/en/sessions#where-transcripts-are-stored).

---

## 1. Config directory resolution

| Fact                                                                                                                                                                                                                                                                                                                                                     | Source                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Default config dir is `~/.claude`. `CLAUDE_CONFIG_DIR` overrides it: "All settings, session history, and plugins are stored under this path, as are credentials on Linux and Windows; on macOS, credentials are in the system Keychain." Documented use: multiple accounts side by side (`alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`). | [docs] https://code.claude.com/docs/en/env-vars                                     |
| "If you set `CLAUDE_CONFIG_DIR`, every `~/.claude` path on this page lives under that directory instead."                                                                                                                                                                                                                                                | [docs] https://code.claude.com/docs/en/claude-directory                             |
| `~/.claude.json` is a **separate file beside** the directory (a "fifth file" Claude Code writes for itself). Whether it also relocates under `CLAUDE_CONFIG_DIR` is not spelled out on the settings page; the env-vars page's "all settings" wording implies it does. Verify per machine (see §16).                                                      | [docs] https://code.claude.com/docs/en/settings#find-or-create-your-settings-files  |
| `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+) names the `projects/<project>` directory explicitly, **only when `CLAUDE_CONFIG_DIR` is also set**, and only from the launching shell environment (not a settings `env` block). Value: 1-64 chars of letters, digits, `-`, `_`.                                                                               | [docs] https://code.claude.com/docs/en/sessions#name-the-project-directory-yourself |
| On this machine `CLAUDE_CONFIG_DIR` is unset; `~/.claude/.credentials.json` is absent; a Keychain item named `Claude Code-credentials` exists (checked by exit code only).                                                                                                                                                                               | [observed]                                                                          |

**Migration rule:** resolve the config dir as `$CLAUDE_CONFIG_DIR || ~/.claude` on
both machines. Never hardcode `~/.claude`. Credentials on macOS are in Keychain and are
**out of scope** (the user signs in again on the target).

---

## 2. Settings scopes

Official scope table (https://code.claude.com/docs/en/settings#settings-files-and-who-they-affect):

| Scope          | File                                                                                                                                                                                                                             | Applies to                         | Notes                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| User           | `~/.claude/settings.json`                                                                                                                                                                                                        | you, every project on this machine | theme, model, statusLine, permissions, `enabledPlugins`, `extraKnownMarketplaces`, hooks, env              |
| Shared project | `<repo>/.claude/settings.json`                                                                                                                                                                                                   | everyone in that folder; commit it | team permissions, hooks, plugins, env                                                                      |
| Project local  | `<repo>/.claude/settings.local.json`                                                                                                                                                                                             | you, this project only             | Claude Code writes permission approvals ("Yes, and don't ask again") and `.mcp.json` server approvals here |
| Managed        | `managed-settings.json` + `managed-settings.d/` + `managed-mcp.json` in `/Library/Application Support/ClaudeCode/` (macOS), `/etc/claude-code/` (Linux/WSL), `C:\Program Files\ClaudeCode\` (Windows); also MDM / server-managed | everyone the org deploys to        | not user-owned; do not migrate (https://code.claude.com/docs/en/managed-settings)                          |

Precedence (highest first): managed → CLI `--settings`/flags → project local → shared
project → user. List keys (e.g. `permissions.allow`) **merge** across files rather than
override. (https://code.claude.com/docs/en/settings#settings-precedence)

Important behaviors for a migration tool:

- **Where `settings.local.json` lives (v2.1.211+):** when started in a subdirectory or a
  worktree of a git repo, Claude Code reads/writes it at the **repository root**, so
  approvals apply across the whole repo. It stays in the starting directory outside a git
  repo, when the repo root is `$HOME`, on Windows, or when the root / `.git` / `.claude`
  entry isn't owned by the user. Pre-2.1.211 files left in subdirectories are still read.
  (https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository)
- **Auto-gitignore:** the first time Claude Code writes `settings.local.json` in a repo that
  doesn't ignore it, it appends `**/.claude/settings.local.json` to the **global** git
  excludes file (`core.excludesFile` if set to an absolute/`~` path, else
  `$XDG_CONFIG_HOME/git/ignore` or `~/.config/git/ignore`). A hand-created file must be
  gitignored by the user. [observed] `~/.config/git/ignore` on this machine contains
  exactly that line. Migration implication: the target machine needs the same global
  exclude or the file may show up as untracked.
  (https://code.claude.com/docs/en/settings#keep-personal-settings-out-of-a-repository)
- **Trust gating:** `permissions.allow`, `permissions.additionalDirectories`,
  `extraKnownMarketplaces`, and most `env` values from a _repository_ file apply only after
  the user accepts the workspace-trust dialog for that folder. An untracked
  `settings.local.json` does not wait for trust. Trust itself is recorded per project in
  `~/.claude.json` (`hasTrustDialogAccepted`) — see §11.
  (https://code.claude.com/docs/en/settings#a-committed-key-doesnt-reach-teammates)
- **Path-bearing keys:** a permission rule that starts with `/`, a relative sandbox path,
  `permissions.additionalDirectories`, `autoMemoryDirectory` (absolute or `~/`), hooks
  `command` strings, and `statusLine.command` can all embed machine paths. [observed] user
  `statusLine.command` = `bash ~/.claude/statusline-command.sh` (a `~`-relative path, so it
  survives a home-dir change; absolute forms would not).
- **Broken `~/.claude.json` handling:** Claude Code copies an unparsable file to
  `~/.claude/backups/.claude.json.corrupted.<ts>` and keeps the five newest
  `.claude.json.backup.<ts>` copies there. (https://code.claude.com/docs/en/settings#fix-a-broken-settings-file)

[observed] user `settings.json` keys on this machine: `agentPushNotifEnabled, effortLevel,
enabledPlugins, extraKnownMarketplaces, inputNeededNotifEnabled, model,
skipDangerousModePermissionPrompt, skipWorkflowUsageWarning, statusLine, theme, tui, voice,
voiceEnabled`. A real project's `.claude/settings.local.json` held `permissions,
enableAllProjectMcpServers, enabledMcpjsonServers`; its `.claude/settings.json` held `hooks`.

---

## 3. Memory files

### 3.1 CLAUDE.md hierarchy (https://code.claude.com/docs/en/memory#choose-where-to-put-claude-md-files)

| Scope          | Location                                                                                                       | Migrate?                             |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Managed policy | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`; Linux `/etc/claude-code/CLAUDE.md`                  | no (org-owned)                       |
| User           | `~/.claude/CLAUDE.md`                                                                                          | yes (user scope)                     |
| Project        | `<repo>/CLAUDE.md` or `<repo>/.claude/CLAUDE.md`; also nested `CLAUDE.md` in subdirectories (loaded on demand) | usually in git; include if untracked |
| Local          | `<repo>/CLAUDE.local.md` (gitignored by convention; "create it manually and add it to `.gitignore`")           | yes (project scope, untracked)       |

Also loaded: `~/.claude/rules/*.md` (user rules) and `<repo>/.claude/rules/**/*.md`
(project rules, optional `paths:` frontmatter). `.claude/rules/` supports symlinks.
(https://code.claude.com/docs/en/memory#organize-rules-with-claude/rules/)

`@path` imports inside CLAUDE.md can be **absolute** paths (relative ones resolve from the
importing file). An absolute import that points into the old home directory breaks after
migration; a `~/`-style import is the documented way to share personal notes across
worktrees. Treat CLAUDE.md content as path-bearing _text_ (warn, don't rewrite).
(https://code.claude.com/docs/en/memory#import-additional-files)

### 3.2 Auto memory (https://code.claude.com/docs/en/memory#auto-memory)

- Location: `~/.claude/projects/<project>/memory/` with a `MEMORY.md` index plus one topic
  file per memory (frontmatter `type:` user/feedback/project/reference, `modified:` ISO
  timestamp since v2.1.214).
- **`<project>` for auto memory is derived from the git repository root**, "so all
  worktrees and subdirectories within the same repo share one auto memory directory.
  Outside a git repo, the project root is used instead." [observed] 35 worktree project
  dirs exist under `projects/`; **0** of them contain `memory/`; the main repo dirs do.
- "Auto memory is machine-local ... Files are not shared across machines or cloud
  environments." — i.e. Anthropic does not sync it; migrating it is exactly what this app
  adds.
- Excluded from the retention sweep; the directory is removed only after being empty for
  the whole retention period (v2.1.228+).
- Overrides: `autoMemoryDirectory` (any settings scope; absolute or `~/` path),
  `autoMemoryEnabled`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and `CLAUDE_CODE_PROJECT_DIR_NAME`
  (moves it to `<config dir>/projects/<name>/memory/`).
  (https://code.claude.com/docs/en/settings-reference#automemorydirectory)
- Subagents with a `memory` field get their **own** directory: `agent-memory/<name>/`
  (project or global) per the directory reference.
  (https://code.claude.com/docs/en/claude-directory)

---

## 4. Transcripts (`projects/<project>/<session>.jsonl`)

### 4.1 Layout

- "Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`,
  where `<project>` is your working directory path with non-alphanumeric characters replaced
  by `-`. For a working directory whose converted name exceeds 200 characters, Claude Code
  truncates the name to 200 characters and appends a hash of the full path."
  (https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)
- Per-session companion directory `projects/<project>/<session-id>/` with:
  `subagents/` (subagent transcripts, named `agent-<hex>.jsonl` [observed]),
  `tool-results/` (large tool outputs spilled to files, `<id>.txt` [observed]),
  and [observed, undocumented] `workflows/` (with `scripts/`). Docs list `subagents/` and
  `tool-results/` explicitly. (https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)
- [observed] 42 project dirs, 601 `.jsonl`, 416 MB; 17 per-session dirs
  (`tool-results` in 13, `subagents` in 10, `workflows` in 5).
- Transcripts, history, and paste cache are **plaintext**; anything a tool reads (including
  `.env` contents) lands in the JSONL. Migrating transcripts therefore migrates secrets that
  were ever printed. Encrypt the bundle. (https://code.claude.com/docs/en/claude-directory#plaintext-storage)

### 4.2 Record types [observed, 2.1.247; census over 77,232 records]

`assistant`, `user`, `attachment`, `last-prompt`, `ai-title`, `mode`, `permission-mode`,
`atis-latch`, `queue-operation`, `system` (subtypes incl. `turn_duration`,
`stop_hook_summary`, `away_summary`, `local_command`, `compact_boundary`, `api_error`),
`relocated`, `worktree-state`, `bridge-session`, `file-history-delta`, `custom-title`,
`agent-name`, `file-history-snapshot`, `pr-link`, `cost-state`.

Key shapes [observed]:

| type                                       | keys                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user` / `assistant`                       | `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `message`, `parentUuid`, `sessionId`, `timestamp`, `type`, `userType`, `uuid`, `version`, plus `toolUseResult`, `permissionMode`, `promptId`, `requestId`, ... |
| `attachment`                               | `attachment{type,...}`, `cwd`, `gitBranch`, `sessionId`, `uuid`, `parentUuid`, ...                                                                                                                              |
| `last-prompt`                              | `lastPrompt`, `leafUuid`, `sessionId`                                                                                                                                                                           |
| `ai-title` / `custom-title` / `agent-name` | `aiTitle` / `customTitle` / `agentName`, `sessionId`                                                                                                                                                            |
| `permission-mode` / `mode`                 | `permissionMode` / `mode`, `sessionId`                                                                                                                                                                          |
| `relocated`                                | `relocatedCwd` (absolute path), `sessionId` — written when a session moves dir (`/cd`, worktree enter/exit)                                                                                                     |
| `worktree-state`                           | `worktreeSession{originalCwd, preEnterOriginalCwd, worktreePath}` (all absolute), `sessionId`                                                                                                                   |
| `bridge-session`                           | `bridgeSessionId`, `lastSequenceNum`, `ownerAccountUuid`, `ownerOrganizationUuid` (Remote Control binding — account-specific)                                                                                   |
| `file-history-snapshot`                    | `messageId`, `isSnapshotUpdate`, `snapshot{messageId, timestamp, trackedFileBackups{<relpath>: {realParentDir, ...}}}`                                                                                          |
| `file-history-delta`                       | `messageId`, `snapshotMessageId`, `trackingPath` (absolute), `backup{backupFileName, backupTime, realParentDir, version}`                                                                                       |
| `pr-link`                                  | `prNumber`, `prRepository`, `prUrl`                                                                                                                                                                             |
| `cost-state`                               | `totalCostUSD`, `modelUsage`, durations, line counts                                                                                                                                                            |

### 4.3 Path-bearing fields [observed]

- Top-level `cwd` on every message record — the canonical evidence of which directory the
  session ran in.
- `relocatedCwd`; `worktreeSession.originalCwd / preEnterOriginalCwd / worktreePath`.
- `backup.realParentDir`, `snapshot.trackedFileBackups.<rel>.realParentDir`, `trackingPath`
  (checkpoint bookkeeping; `trackingPath` was seen pointing into
  `~/.claude/projects/<dir>/memory/*.md`, i.e. checkpoints also track auto-memory files).
- `toolUseResult.*` string fields that held absolute paths in a 300-file sample:
  `filePath`, `file.filePath`, `originalFile`, `outputFile`, `persistedOutputPath`,
  `scriptPath`, `transcriptDir`, `worktreePath`, `originalCwd`, and free-text fields
  (`content`, `stdout`, `oldString`, `newString`, `file.content`, `file.base64`) that merely
  _contain_ paths.
- `message.content[].input.file_path` etc. are **conversation content** (what the model
  said/called). Do not rewrite them; the model tolerates stale paths, and rewriting risks
  corrupting tool-call/result pairing.
- `history.jsonl` `project` field (see §9) and `sessions/<pid>.json` `cwd` (ephemeral).

### 4.4 Resume semantics that constrain migration (https://code.claude.com/docs/en/sessions)

- `claude --continue` = most recent interactive session **in the current directory**;
  `claude --resume` picker shows sessions from the current worktree (Ctrl+W: all worktrees
  of the repo, Ctrl+A: every project on the machine).
- `claude --resume <session-id>` searches the current project dir and its git worktrees,
  then every other project. "The cross-project search resolves the ID only when exactly one
  other project holds a transcript with messages for it, so a **hand-copied duplicate makes
  Claude Code report not-found**." → a restore must place each session in exactly one
  project directory.
- Resuming a worktree session re-enters the worktree; if the directory is gone, Claude Code
  resumes in the launch dir and clears the binding (benign). Network-path worktrees are
  refused. (https://code.claude.com/docs/en/worktrees#resume-a-worktree-session)
- Not restored on resume: `--mcp-config`, `--settings`, `--plugin-dir`, `--add-dir`; the
  standard settings files are re-read. `plan`/`bypassPermissions` modes never restore.
- `--fork-session` / `/branch` create new session IDs (separate rows); `claude -p` sessions
  are hidden from the picker but resumable by ID.
- `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` or `claude -p --no-session-persistence` suppress
  transcript writes entirely (such sessions never exist on disk).

---

## 5. Project directory name encoding (hypothesis + evidence + verification)

**Official rule [docs]:** non-alphanumeric characters → `-`; names > 200 chars are truncated
to 200 and a hash of the full path is appended
(https://code.claude.com/docs/en/sessions#where-transcripts-are-stored). The hash algorithm
and separator are **not documented**.

**Observed hypothesis [observed]:** `re.sub(r'[^A-Za-z0-9]', '-', abs_cwd)`.

Evidence on this machine (42 project dirs):

- `/Users/<user>/Documents/GitHub/looplift` → `-Users-<user>-Documents-GitHub-looplift`
- `/Users/<user>/Desktop/CRO_Backup` → `-Users-<user>-Desktop-CRO-Backup` (underscore → `-`)
- `/Users/<user>/Documents/GitHub/looplift/.claude/worktrees/pcd-blockers` →
  `-Users-<user>-Documents-GitHub-looplift--claude-worktrees-pcd-blockers` (dot → `-`, so
  `/.` becomes `--`)
- `/private/var/folders/2_/41sndn6j4…/T` → `-private-var-folders-2--41sndn6j4-…-T`
- Automated check: for every project dir, take the first `cwd` found in its transcripts and
  encode it with the regex → **39 match, 0 mismatch, 3 dirs with no `cwd` in the sampled
  lines** (their names are nonetheless consistent with the rule). No dir reported more than
  one distinct first-record `cwd`.

Unknowns: whether "alphanumeric" is ASCII-only or Unicode-aware (no non-ASCII paths were
available to test); case handling on case-insensitive APFS (the rule preserves case);
behavior for the >200-char truncation+hash form.

**Verification strategy (never trust the rule blindly):**

1. On the **source**, build the map `dirName → cwd` from transcript evidence (first
   message record with `cwd` in each `.jsonl`, majority vote across files). Confirm
   `encode(cwd) == dirName` for every dir; any mismatch or any name of exactly 200+ chars
   with a suffix is flagged as "unsupported encoding — copy verbatim only if the target path
   is identical".
2. On the **target**, compute `encode(newCwd)`; if a directory already exists there, verify
   it belongs to the same path via its own transcripts before merging.
3. After the first launch on the target, cross-check the live evidence
   (`sessions/<pid>.json` `cwd` / hook `transcript_path`) against the predicted dir and
   surface a diagnostic if they differ.
4. Keep the encoder in one module with the evidence-based self-test above, so a future
   format change fails loudly rather than silently scattering sessions.

---

## 6. Retention: `cleanupPeriodDays`

- Setting (any settings file): number of days, whole number, **minimum 1, default 30;
  `0` fails validation** ("pick a large value such as 3650 for long retention"). Sweep runs in
  the background after a session starts, "as long as it can safely determine the retention
  period". (https://code.claude.com/docs/en/settings-reference#cleanupperioddays)
- Also cited on the costs page (report files) and data-usage page ("30 days by default to
  enable session resumption"). (https://code.claude.com/docs/en/costs, https://code.claude.com/docs/en/data-usage#data-retention)
- Paths swept (https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically):
  `projects/<project>/<session>.jsonl`, `projects/<project>/<session>/subagents/`,
  `projects/<project>/<session>/tool-results/`, `file-history/<session>/` (100 most
  recent checkpoints; first snapshot of each file kept), `plans/`, `debug/`, `paste-cache/`,
  `image-cache/<session>/` (other sessions' dirs removed on every sweep regardless of age),
  `uploads/<session>/`, `session-env/`, `tasks/`, `shell-snapshots/` (removed on clean
  exit), `backups/` (five newest kept), `feedback-bundles/`, `feedback/drafts/`,
  `usage-data/`, legacy `todos/`, `statsig/`, `logs/`.
- Exceptions: `sessions/` (live registry, removed on exit / crash cleanup), auto memory
  `projects/<project>/memory/`, `--bare` runs (no sweep), and a **paused sweep** when the
  retention period can't be determined (settings error) — managed `cleanupPeriodDays`
  still runs.
- Same cutoff applies to orphaned subagent/background-session worktrees
  (https://code.claude.com/docs/en/worktrees#clean-up-subagent-and-background-session-worktrees).
- [observed] `~/.claude/.last-cleanup` holds an ISO timestamp of the last sweep;
  `~/.claude/plugins/.last_inuse_sweep` likewise for the plugin-cache orphan sweep.

**Migration implications:**

- The docs do not say whether age is judged by file mtime or by record timestamps. Preserve
  mtimes on restore (tar does), and warn when restoring sessions older than the _target's_
  `cleanupPeriodDays`, offering to raise it in `~/.claude/settings.json`.
- A restore that lands while the target's sweep is paused/unpaused is unaffected; the sweep
  is age-based only.

---

## 7. Checkpoints / `file-history/`

- "Every user prompt creates a new checkpoint"; snapshots kept for the 100 most recent
  checkpoints per session; saved with the conversation so `/rewind` works after resume;
  deleted with sessions per the retention sweep. Only edits by Claude's file tools are
  tracked (not Bash, not most subagents, not symlinked/hard-linked files).
  (https://code.claude.com/docs/en/checkpointing)
- Toggle: `fileCheckpointingEnabled` (https://code.claude.com/docs/en/settings-reference).
- [observed] `~/.claude/file-history/<session-uuid>/<16-hex-file-id>@v<N>` — one dir per
  session (45 dirs, 23 MB), versioned content blobs. The mapping from blob to real file is
  in the transcript's `file-history-snapshot` / `file-history-delta` records
  (`trackedFileBackups{<relpath>: {realParentDir,...}}`, `backup.realParentDir`,
  `trackingPath`), which are absolute-path bearing (§4.3).
- Migration: include `file-history/<session>/` **only for sessions being migrated**; it is
  useless without the matching transcript and vice-versa (rewind would silently skip). If
  repo paths change, `realParentDir`/`trackingPath` must be remapped for restore-code to
  work; leaving them stale merely disables rewind for those files.

---

## 8. `session-env/`

- [docs] "Per-session environment metadata", swept by retention.
  (https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)
- [docs] Mechanism: `CLAUDE_ENV_FILE` is "a shell script whose contents Claude Code runs
  before each Bash command"; SessionStart/Setup/CwdChanged/FileChanged hooks append
  `export` lines to it. (https://code.claude.com/docs/en/env-vars,
  https://code.claude.com/docs/en/hooks#persist-environment-variables)
- [observed] `~/.claude/session-env/<session-uuid>/sessionstart-hook-<N>.sh` (209 dirs,
  452 KB) — e.g. an `export VERCEL_PLUGIN_BOOTSTRAP_HINTS=...` line from a plugin hook.
- Classification: **ephemeral** (regenerated by hooks at next SessionStart; may contain
  secrets exported by hooks). Exclude.

---

## 9. `history.jsonl` and `paste-cache/`

- [docs] `history.jsonl`: "Every prompt you've typed, with timestamp and project path. Used
  for up-arrow recall." **Not** covered by the retention sweep. `claude project purge <path>`
  filters matching lines out; `--all` deletes the file.
  (https://code.claude.com/docs/en/claude-directory#kept-until-you-delete-them)
- [observed] one record per line with keys `display` (str), `pastedContents` (dict, usually
  empty), `timestamp` (int ms), `project` (absolute path), `sessionId`. 1,946 records,
  66 with pastes. `pastedContents` entries are `{id, type, contentHash}`; the bodies live in
  `~/.claude/paste-cache/<16-hex>.txt` (swept; "Pasted text in recalled prompts" is lost
  without it).
- Migration: **user scope**, path-bearing (`project`). Filter to the projects being migrated
  and rewrite `project` with the path map; append to (don't replace) the target file; carry
  referenced `paste-cache/` files only if the user opts in (they are plaintext pastes).

---

## 10. `~/.claude.json` (global config / app state)

[docs] Holds "your sign-in session, MCP server configurations, per-project state such as
trust decisions, and the global config keys that `/config` writes for you." The directory
reference summarizes it as "App state, OAuth, UI toggles, personal MCP servers." Global
config keys (`autoConnectIde`, `autoInstallIdeExtension`, `diffTool`,
`externalEditorContext`, `permissionExplainerEnabled`, removed `teammateDefaultModel`) are
read **only** from this file; `permissions`/`hooks`/`env` placed here are ignored.
(https://code.claude.com/docs/en/settings#find-or-create-your-settings-files,
https://code.claude.com/docs/en/claude-directory,
https://code.claude.com/docs/en/settings-reference#global-config-settings,
https://code.claude.com/docs/en/debug-your-config)

[observed] 79 KB, ~75 top-level keys. Grouped:

| Group                 | Keys (observed)                                                                                                                                           | Classification                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Identity / auth       | `oauthAccount` (20 keys incl. `accountUuid`, `emailAddress`, `organizationUuid`, `displayName`, billing/seat fields), `userID`, `machineID`               | **secret / machine-bound — never migrate** (macOS access tokens are in Keychain, but this block still identifies the account) |
| Per-project state     | `projects{<abs path>: {...}}`                                                                                                                             | **project scope**, path-keyed                                                                                                 |
| MCP user scope        | top-level `mcpServers` (empty here)                                                                                                                       | user scope; `env`/`headers` may hold secrets → opt-in                                                                         |
| Global config toggles | `diffTool`, `autoConnectIde`, ... (`/config` writes them)                                                                                                 | user scope, safe                                                                                                              |
| Repo index            | `githubRepoPaths{"owner/repo": ["<abs path>", ...]}`                                                                                                      | path-bearing; re-key/remap                                                                                                    |
| Usage counters        | `skillUsage`, `pluginUsage`, `numStartups`, `tips*`, `*SeenCount`                                                                                         | harmless; skip                                                                                                                |
| Caches                | `cachedGrowthBookFeatures` (561 entries), `cachedExperiment*`, `*Cache`, `changelogLastFetched`, `claudeAiMcpEverConnected`, `mcp-needs-auth`-style flags | ephemeral; skip                                                                                                               |
| Install               | `installMethod`, `autoUpdates*`, `firstStartTime`, `migrationVersion`, `lastOnboardingVersion`                                                            | machine-bound; skip                                                                                                           |

`projects[<abs path>]` keys [observed, frequency over 10 entries]: `allowedTools` (legacy
allow list), `mcpContextUris`, `enabledMcpjsonServers`, `disabledMcpjsonServers`,
`hasTrustDialogAccepted`, `hasClaudeMdExternalIncludesApproved`,
`hasClaudeMdExternalIncludesWarningShown`, `mcpServers` (local-scope MCP; `{type, command,
args, env}`), `enabledMcpServers`/`disabledMcpServers`, `lastSessionId`, `lastCost`,
`last*` metrics, `lastSessionMetrics`, `exampleFiles`, `exampleFilesGeneratedAt`,
`hasUnseenTeamArtifacts`, `loggedAuthoredArtifactPaths` (relative paths),
`hasUsedRemoteSession`, `lastGracefulShutdown`, `lastVersionBase`.

Three project entries are keyed by **worktree paths that no longer exist**
(`<repo>/.claude/worktrees/<name>`) — stale entries accumulate; a migration should not
recreate entries for paths that won't exist on the target.

**Migration strategy:** never copy the file. Merge selected `projects[old]` entries under
the remapped key on the target (`allowedTools`, `enabledMcpjsonServers`,
`disabledMcpjsonServers`, `hasClaudeMdExternalIncludesApproved`, optionally
`hasTrustDialogAccepted` — carrying trust is a security decision the user should confirm —
and `mcpServers` only with explicit consent because `env` may hold tokens). Write via the
same backup discipline Claude Code uses (`backups/.claude.json.backup.<ts>`), and only while
no Claude Code process is running (§14).

---

## 11. MCP configuration locations

Scope table (https://code.claude.com/docs/en/mcp#mcp-installation-scopes):

| Scope           | Loads in                        | Stored in                                            |
| --------------- | ------------------------------- | ---------------------------------------------------- |
| Local (default) | current project only            | `~/.claude.json` → `projects[<abs path>].mcpServers` |
| Project         | current project, shared via VCS | `<repo>/.mcp.json` (`{ "mcpServers": {...} }`)       |
| User            | all projects                    | `~/.claude.json` top-level `mcpServers`              |
| Managed         | org                             | `managed-mcp.json` in the managed dir (§2)           |

- Precedence: local > project > user > plugin-provided > claude.ai connectors; whole entries
  win, no field merge.
- Project `.mcp.json` servers require interactive approval; approvals are written to
  `.claude/settings.local.json` as `enabledMcpjsonServers` / `enableAllProjectMcpServers`
  (and `disabledMcpjsonServers`); `claude mcp reset-project-choices` clears them.
  (https://code.claude.com/docs/en/settings-reference#enabledmcpjsonservers)
- [observed] a real project's `.mcp.json` defines an HTTP server with `headers` — headers
  and `env` blocks are where MCP secrets live. `~/.claude/mcp-needs-auth-cache.json` caches
  which servers need auth (ephemeral). MCP OAuth tokens themselves were not located in
  `~/.claude` (likely Keychain on macOS — open question).
- Migration: `.mcp.json` is a project file (often committed; include if untracked or
  modified). Local/user MCP in `~/.claude.json` is a **merge** operation (§10), opt-in when
  `env`/`headers` are present. Servers whose `command`/`args` reference absolute paths are
  path-bearing.

---

## 12. Plugins, skills, agents, and other authored config

Authored files (all documented at https://code.claude.com/docs/en/claude-directory):

| File                                                           | Project (`<repo>/.claude/`) | Global (`~/.claude/`) | Notes                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md` / `rules/*.md`                                     | yes                         | yes                   | §3                                                                                                                                                   |
| `settings.json` / `settings.local.json`                        | yes                         | user file only        | §2                                                                                                                                                   |
| `skills/<name>/SKILL.md`                                       | yes                         | yes                   | precedence enterprise > personal > project; `~/.claude/skills/synced/` reserved for claude.ai-synced skills (https://code.claude.com/docs/en/skills) |
| `commands/*.md`                                                | yes                         | yes                   | legacy single-file skills                                                                                                                            |
| `agents/*.md`                                                  | yes                         | yes                   | scanned recursively; identity from `name` frontmatter (https://code.claude.com/docs/en/sub-agents)                                                   |
| `output-styles/*.md`, `workflows/*.js`, `agent-memory/<name>/` | yes                         | yes                   |                                                                                                                                                      |
| `keybindings.json`, `themes/*.json`                            | –                           | yes                   | user only                                                                                                                                            |
| `.mcp.json`, `.worktreeinclude`                                | repo root                   | –                     | project only                                                                                                                                         |

Plugins (https://code.claude.com/docs/en/plugins-reference):

- Install scope decides which settings file gets `enabledPlugins["name@marketplace"]`:
  `user` → `~/.claude/settings.json` (default), `project` → `.claude/settings.json`,
  `local` → `.claude/settings.local.json`, `managed`. `extraKnownMarketplaces` registers
  marketplaces (repo entries wait for trust).
- Marketplace plugins are **copied into the plugin cache** `~/.claude/plugins/cache/`
  (except `command` sources in link mode), "grouped by marketplace and plugin and named for
  the resolved version"; old versions are marked orphaned and swept ~14 days later.
- `${CLAUDE_PLUGIN_DATA}` = `~/.claude/plugins/data/<id>/` (id = plugin identifier with
  chars outside `[A-Za-z0-9_-]` → `-`), persisted across updates, deleted on last uninstall
  unless `--keep-data`.
- `~/.claude/plugins/synced/` holds claude.ai-synced plugins in Cowork/cloud sessions only.
- [observed] `~/.claude/plugins/` (92 MB): `installed_plugins.json` (`{version, plugins{
"<name>@<marketplace>": [{scope, version, installPath (absolute), installedAt,
lastUpdated, gitCommitSha}]}}`), `known_marketplaces.json` (`{<name>: {source,
installLocation (absolute), lastUpdated}}`), `plugin-catalog-cache.json`,
  `cache/<marketplace>/<plugin>/<version-hash>/`, `cache/temp_git_*` (transient clones),
  `marketplaces/<name>/` (git clone of the marketplace with `.claude-plugin/`, `.gcs-sha`),
  `data/<id>/`, `.last_inuse_sweep`. The docs say don't delete `~/.claude/plugins/`
  ("holds ... installed plugins") but do not document these two JSON files.

**Migration:** treat `enabledPlugins` + `extraKnownMarketplaces` (settings) and
`installed_plugins.json` + `known_marketplaces.json` as the **manifest**; on the target,
re-install via `claude plugin marketplace add` / `claude plugin install` rather than
copying `cache/` (absolute `installPath`s, Node deps built per machine). Copy
`plugins/data/<id>/` only on request (can be large, may hold per-machine venvs). Copy
`~/.claude/skills`, `agents`, `commands`, `rules`, `output-styles`, `workflows`,
`agent-memory`, `keybindings.json`, `themes/`, `statusline-command.sh` (or whatever
`statusLine.command` references) verbatim; preserve symlinks as symlinks and warn when a
symlink target is outside the bundle.

---

## 13. Worktrees

- `claude --worktree <name>` / `EnterWorktree` create `<repo>/.claude/worktrees/<name>/` on
  branch `worktree-<name>` (PR form: `.claude/worktrees/pr-<number>`). Unnamed sessions get
  a generated name and auto-remove when clean; named or dirty worktrees prompt keep/remove;
  `-p` runs never clean up. (https://code.claude.com/docs/en/worktrees)
- **Transcript location follows the worktree:** on enter/exit Claude Code "records the
  session under the session's new working directory ... Exiting moves it back the same way"
  (v2.1.198+). [observed] 35 `…--claude-worktrees-<name>` project dirs remain although 0
  worktrees exist now, and `~/.claude.json` still has 3 entries keyed by deleted worktree
  paths. `relocated` and `worktree-state` records carry the absolute paths.
- Shared with the main checkout: the repo's `.git` dir (worktree metadata lives in
  `<repo>/.git/worktrees/<name>`), project-scope plugins, and permission approvals
  (`settings.local.json` at the repo root, v2.1.211+).
- `.worktreeinclude` (gitignore syntax, committed) lists gitignored files (e.g. `.env`,
  `.env.local`) to copy into every new worktree. A `WorktreeCreate` hook can relocate
  worktrees anywhere — the tool cannot assume `.claude/worktrees/`.
- Refusals: Claude Code refuses symlinked `.claude`/`.claude/worktrees`, network-path
  worktrees, and worktrees whose `.git` resolves into the main checkout.
- Sweep: subagent/background-session worktrees older than `cleanupPeriodDays` are removed
  only if clean and marked by Claude Code (v2.1.246+); user-created worktrees are kept.
- [observed] `git worktree list --porcelain` emits `worktree <path>` / `HEAD <sha>` /
  `branch refs/heads/<name>` blocks (plus `detached`, `bare`, `locked`, `prunable`).

**Migration:** a worktree is a git construct, not a Claude Code file. Capture
`git worktree list --porcelain` + per-worktree status (branch, HEAD, dirty files); on the
target recreate with `git worktree add <path> <branch>` **before** restoring that worktree's
project dir, so `--resume` can re-enter it. Orphaned worktree session dirs (no matching
worktree) are still resumable — Claude Code just resumes in the launch dir — so they can be
migrated as ordinary project dirs or skipped by user choice.

---

## 14. Ephemeral / machine-bound (exclude by default)

| Path                                                                                                                                                                                            | Why                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions/<pid>.json`, `<pid>.<hash>.key`                                                                                                                                                       | live process registry with peer tokens; removed on exit / crash cleanup [docs + observed keys: `cwd`, `pid`, `sessionId`, `messagingSocketPath`, `status`, ...]. **Also: do not write to `~/.claude*` while any entry is live.** |
| `shell-snapshots/snapshot-zsh-<ts>-<id>.sh`                                                                                                                                                     | startup shell env; removed on clean exit                                                                                                                                                                                         |
| `ide/<pid>.lock`                                                                                                                                                                                | IDE bridge lock                                                                                                                                                                                                                  |
| `telemetry/1p_failed_events.*.json`                                                                                                                                                             | unsent telemetry                                                                                                                                                                                                                 |
| `cache/changelog.md`, `cache/my-closed-issues.json`, `remote-settings.json`, `policy-limits.json`, `mcp-needs-auth-cache.json`, `plugins/plugin-catalog-cache.json`, `plugins/cache/temp_git_*` | re-fetched caches (docs: "Nothing" lost)                                                                                                                                                                                         |
| `session-env/`, `tasks/`, `plans/`, `debug/`, `image-cache/`, `uploads/`, `todos/`, `statsig/`, `logs/`                                                                                         | swept session data; docs: deleting loses "Nothing user-facing" (uploads: Remote Control attachments)                                                                                                                             |
| `backups/`                                                                                                                                                                                      | copies of `~/.claude.json`                                                                                                                                                                                                       |
| `usage-data/`, `stats-cache.json`                                                                                                                                                               | `/insights` reports and `/usage` totals — machine history, optional                                                                                                                                                              |
| `feedback-bundles/`, `feedback/drafts/`                                                                                                                                                         | unsent feedback archives (contain transcripts)                                                                                                                                                                                   |
| `security/` (355 MB: `agent-sdk-venv/` Python venv, `log.txt*`, `security_warnings_state_<session>.json/.lock`)                                                                                 | [observed only, undocumented in the fetched pages] plugin/feature-generated venv + per-session warning state; regenerable                                                                                                        |
| `downloads/`, `.last-cleanup`, `.last-update-result.json`, `plugins/.last_inuse_sweep`                                                                                                          | markers                                                                                                                                                                                                                          |
| `~/.claude.json` identity/caches (§10)                                                                                                                                                          | account- and machine-bound                                                                                                                                                                                                       |
| macOS Keychain `Claude Code-credentials`                                                                                                                                                        | secret; user re-authenticates                                                                                                                                                                                                    |

Project-side ephemera [observed]: `<repo>/.claude/scheduled_tasks.lock`,
`<repo>/.claude/worktrees/` (git worktrees, §13). `<repo>/.claude/RESUME.md` was a
plugin-written note (user data; include with project scope).

---

## 15. Migration classification table

Scope legend: **project** = tied to one repo path (must be remapped per project);
**user** = machine-wide personal config; **ephemeral** = regenerated, exclude;
**secret** = never bundle, or opt-in with explicit consent and encryption.

| Artifact                                                                                     | Path (under config dir unless noted)                                                                                                                                                                                        | Scope                                          | Default include?                                                                                                                                        | Path-bearing?                                                                                                                                                                                                                                                                  | Remap strategy                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcripts                                                                                  | `projects/<enc>/<session>.jsonl`                                                                                                                                                                                            | project                                        | yes (per selected project; contains plaintext tool output — encrypt bundle)                                                                             | yes: `cwd`, `relocatedCwd`, `worktreeSession.*`, `backup.realParentDir`, `snapshot.trackedFileBackups.*.realParentDir`, `trackingPath`, `toolUseResult.{filePath,file.filePath,originalFile,outputFile,persistedOutputPath,scriptPath,transcriptDir,worktreePath,originalCwd}` | Re-encode dir name from the **new** cwd (§5). Rewrite only the listed metadata fields with a prefix map (old repo root → new, old `~` → new); never touch `message.content`. Place each session in exactly one project dir. Preserve mtimes. |
| Per-session dirs                                                                             | `projects/<enc>/<session>/{subagents,tool-results,workflows}/`                                                                                                                                                              | project                                        | yes, with the transcript                                                                                                                                | subagent JSONL: same fields as transcripts                                                                                                                                                                                                                                     | Same as transcripts.                                                                                                                                                                                                                         |
| Auto memory                                                                                  | `projects/<enc-of-repo-root>/memory/*.md`                                                                                                                                                                                   | project (shared across worktrees)              | **yes** (high value, small, never swept, not synced by Anthropic)                                                                                       | markdown text may mention paths                                                                                                                                                                                                                                                | Copy under the re-encoded **repo root** dir; never under worktree dirs. Honor `autoMemoryDirectory` if set.                                                                                                                                  |
| Checkpoints                                                                                  | `file-history/<session>/<id>@v<N>`                                                                                                                                                                                          | project (keyed by session)                     | yes for migrated sessions only                                                                                                                          | no (blobs); mapping is in transcript records                                                                                                                                                                                                                                   | Copy verbatim alongside the transcript; remap the transcript's `realParentDir`/`trackingPath`.                                                                                                                                               |
| Prompt history                                                                               | `history.jsonl`                                                                                                                                                                                                             | user (path-keyed rows)                         | yes (filtered to migrated projects)                                                                                                                     | yes: `project`                                                                                                                                                                                                                                                                 | Rewrite `project`; **append** to target file.                                                                                                                                                                                                |
| Paste cache                                                                                  | `paste-cache/<id>.txt`                                                                                                                                                                                                      | user                                           | opt-in (only ids referenced by migrated history rows)                                                                                                   | no                                                                                                                                                                                                                                                                             | Copy verbatim.                                                                                                                                                                                                                               |
| User memory                                                                                  | `CLAUDE.md`, `rules/`                                                                                                                                                                                                       | user                                           | yes                                                                                                                                                     | `@` imports may be absolute                                                                                                                                                                                                                                                    | Copy; warn on absolute imports.                                                                                                                                                                                                              |
| User settings                                                                                | `settings.json`                                                                                                                                                                                                             | user                                           | yes (merge or replace, user choice)                                                                                                                     | `statusLine.command`, hooks, `permissions.additionalDirectories`, absolute permission rules, `autoMemoryDirectory`                                                                                                                                                             | Copy; rewrite `~`/old-home prefixes; warn on other absolute paths.                                                                                                                                                                           |
| User settings local                                                                          | `settings.local.json` (in `~/.claude`)                                                                                                                                                                                      | user                                           | yes                                                                                                                                                     | same                                                                                                                                                                                                                                                                           | [observed `{}`]                                                                                                                                                                                                                              |
| Status line script                                                                           | file named by `statusLine.command`                                                                                                                                                                                          | user                                           | yes                                                                                                                                                     | –                                                                                                                                                                                                                                                                              | Copy; keep relative to `~`.                                                                                                                                                                                                                  |
| Skills / agents / commands / output-styles / workflows / agent-memory / keybindings / themes | `skills/`, `agents/`, `commands/`, `output-styles/`, `workflows/`, `agent-memory/`, `keybindings.json`, `themes/`                                                                                                           | user                                           | yes                                                                                                                                                     | scripts inside may hardcode paths                                                                                                                                                                                                                                              | Copy verbatim, preserve symlinks; skip `skills/synced/`.                                                                                                                                                                                     |
| Plugin manifest                                                                              | `settings.json.enabledPlugins`, `extraKnownMarketplaces`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`                                                                                               | user                                           | yes (as manifest)                                                                                                                                       | `installPath`, `installLocation` absolute                                                                                                                                                                                                                                      | Do not copy JSON verbatim; drive `claude plugin marketplace add` / `claude plugin install --scope user` on the target.                                                                                                                       |
| Plugin cache / marketplaces                                                                  | `plugins/cache/`, `plugins/marketplaces/`                                                                                                                                                                                   | ephemeral (rebuildable)                        | no                                                                                                                                                      | yes                                                                                                                                                                                                                                                                            | Reinstall.                                                                                                                                                                                                                                   |
| Plugin data                                                                                  | `plugins/data/<id>/`                                                                                                                                                                                                        | user                                           | opt-in                                                                                                                                                  | possibly (venvs, node_modules)                                                                                                                                                                                                                                                 | Copy only on request.                                                                                                                                                                                                                        |
| Global config toggles                                                                        | `~/.claude.json` global keys (`diffTool`, `autoConnectIde`, ...)                                                                                                                                                            | user                                           | yes                                                                                                                                                     | no                                                                                                                                                                                                                                                                             | Merge keys into target file.                                                                                                                                                                                                                 |
| Per-project app state                                                                        | `~/.claude.json.projects[<abs path>]`                                                                                                                                                                                       | project                                        | partial: `allowedTools`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `hasClaudeMdExternalIncludesApproved`; **ask** for `hasTrustDialogAccepted` | key is the path                                                                                                                                                                                                                                                                | Re-key to the new path; merge; skip entries for paths that won't exist.                                                                                                                                                                      |
| Local/user MCP servers                                                                       | `~/.claude.json.projects[*].mcpServers`, top-level `mcpServers`                                                                                                                                                             | project / user + **secret**                    | opt-in (env/headers may hold tokens)                                                                                                                    | `command`/`args` may be absolute                                                                                                                                                                                                                                               | Merge with consent; flag secrets.                                                                                                                                                                                                            |
| Repo index                                                                                   | `~/.claude.json.githubRepoPaths`                                                                                                                                                                                            | user                                           | yes                                                                                                                                                     | values are absolute paths                                                                                                                                                                                                                                                      | Remap values.                                                                                                                                                                                                                                |
| Account identity                                                                             | `~/.claude.json.oauthAccount`, `userID`, `machineID`                                                                                                                                                                        | secret / machine                               | **never**                                                                                                                                               | –                                                                                                                                                                                                                                                                              | User signs in on the target.                                                                                                                                                                                                                 |
| Credentials                                                                                  | macOS Keychain `Claude Code-credentials` (`.credentials.json` on Linux/Windows)                                                                                                                                             | secret                                         | **never**                                                                                                                                               | –                                                                                                                                                                                                                                                                              | Re-login.                                                                                                                                                                                                                                    |
| Project memory                                                                               | `<repo>/CLAUDE.md`, `<repo>/.claude/CLAUDE.md`, `<repo>/.claude/rules/`                                                                                                                                                     | project                                        | include if untracked/modified (otherwise git carries it)                                                                                                | `@` imports                                                                                                                                                                                                                                                                    | Copy with the repo snapshot.                                                                                                                                                                                                                 |
| Project local memory                                                                         | `<repo>/CLAUDE.local.md`                                                                                                                                                                                                    | project                                        | yes (gitignored by design)                                                                                                                              | text                                                                                                                                                                                                                                                                           | Copy.                                                                                                                                                                                                                                        |
| Project settings                                                                             | `<repo>/.claude/settings.json`                                                                                                                                                                                              | project                                        | if untracked/modified                                                                                                                                   | hooks                                                                                                                                                                                                                                                                          | Copy.                                                                                                                                                                                                                                        |
| Project local settings                                                                       | `<repo>/.claude/settings.local.json` (repo root)                                                                                                                                                                            | project                                        | **yes** (approvals + MCP approvals; always gitignored)                                                                                                  | absolute permission rules                                                                                                                                                                                                                                                      | Copy; ensure global git excludes has `**/.claude/settings.local.json`.                                                                                                                                                                       |
| Project MCP                                                                                  | `<repo>/.mcp.json`                                                                                                                                                                                                          | project (+ possible secret in `headers`/`env`) | if untracked/modified; warn on secrets                                                                                                                  | `command` paths                                                                                                                                                                                                                                                                | Copy.                                                                                                                                                                                                                                        |
| Project skills/agents/commands                                                               | `<repo>/.claude/{skills,agents,commands,output-styles,workflows,agent-memory}/`                                                                                                                                             | project                                        | if untracked                                                                                                                                            | –                                                                                                                                                                                                                                                                              | Copy.                                                                                                                                                                                                                                        |
| `.worktreeinclude`                                                                           | repo root                                                                                                                                                                                                                   | project                                        | with repo                                                                                                                                               | –                                                                                                                                                                                                                                                                              | Copy.                                                                                                                                                                                                                                        |
| Worktrees                                                                                    | `<repo>/.claude/worktrees/<name>/` + `<repo>/.git/worktrees/<name>`                                                                                                                                                         | project (git)                                  | metadata yes; contents via git state capture                                                                                                            | yes                                                                                                                                                                                                                                                                            | Recreate with `git worktree add` before restoring that worktree's sessions.                                                                                                                                                                  |
| Env files                                                                                    | `<repo>/.env*` (gitignored)                                                                                                                                                                                                 | project + **secret**                           | opt-in, encrypted                                                                                                                                       | –                                                                                                                                                                                                                                                                              | Copy with consent (already in this app's scope).                                                                                                                                                                                             |
| Managed settings / managed CLAUDE.md / managed-mcp                                           | `/Library/Application Support/ClaudeCode/*`                                                                                                                                                                                 | org                                            | no                                                                                                                                                      | –                                                                                                                                                                                                                                                                              | Org redeploys.                                                                                                                                                                                                                               |
| Everything in §14                                                                            | `sessions/`, `shell-snapshots/`, `ide/`, `telemetry/`, `cache/`, `security/`, `session-env/`, `tasks/`, `plans/`, `debug/`, `image-cache/`, `uploads/`, `backups/`, `usage-data/`, `stats-cache.json`, `feedback*`, markers | ephemeral                                      | no                                                                                                                                                      | –                                                                                                                                                                                                                                                                              | –                                                                                                                                                                                                                                            |

Operational rules that fall out of the docs:

1. **Quiesce first.** Refuse to back up or restore while `sessions/*.json` entries are live
   (transcripts are written asynchronously; `~/.claude.json` is rewritten by Claude Code).
2. **One home for each session.** Duplicate transcripts across project dirs make
   `--resume <id>` fail (§4.4).
3. **Encode, then verify.** Derive `projects/<enc>` names from the target path with the §5
   encoder and the evidence-based self-test; never reuse source dir names when the path
   changes.
4. **Retention awareness.** Warn when migrated sessions are older than the target's
   `cleanupPeriodDays`; offer to raise it (§6).
5. **Secrets are opt-in and encrypted**: transcripts, `.env*`, MCP `env`/`headers`,
   `session-env`, paste cache.
6. **Never bundle identity**: `oauthAccount`, `userID`, `machineID`, Keychain.

---

## 16. Open questions

1. Does `~/.claude.json` move under `CLAUDE_CONFIG_DIR`? (env-vars page implies "all
   settings" do; the settings page describes it only as `~/.claude.json`.) Test with a
   throwaway `CLAUDE_CONFIG_DIR`.
2. Is the retention sweep age based on file mtime or on record timestamps? Affects whether
   preserving mtimes is sufficient for restored sessions.
3. Exact hash/separator used when the encoded project name exceeds 200 characters; whether
   "alphanumeric" is ASCII-only for non-ASCII paths.
4. Where MCP OAuth tokens are stored on macOS (Keychain assumed; not verified).
5. Whether Claude Code re-derives anything from `cwd` inside old records on resume (e.g.
   `gitBranch` display) — i.e. whether metadata rewriting is required or merely cosmetic.
   Empirical test: restore a session with unmodified `cwd` into a re-encoded dir and resume.
6. The `workflows/` per-session subdirectory and the `security/` tree are undocumented in
   the fetched pages; confirm their owners (dynamic workflows feature; security-guidance
   plugin / Agent SDK) before finalizing exclusions.
7. `hasTrustDialogAccepted` transfer: product decision (convenience vs. re-affirming trust
   on a new machine).

## Sources

- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/settings-reference
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/checkpointing
- https://code.claude.com/docs/en/worktrees
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/plugins
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/env-vars
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/common-workflows
- https://code.claude.com/docs/en/data-usage
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/managed-settings
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/debug-your-config
- https://code.claude.com/docs/en/cloud-environments
- Machine inspection notes: `scratchpad/discovery-findings.md` (2026-08-27, Claude Code 2.1.247)
