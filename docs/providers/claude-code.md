# Claude Code provider (`@devmig/provider-claude-code`)

Provider id `claude-code` · payload schema v1 · `supportsGlobal: true`.

Migrates the local state of Claude Code for the selected projects (sessions, project memory, checkpoints, prompt
history, per-project entries of `~/.claude.json`, project-side files) and the user-wide "Global Claude Code
Environment" (settings, CLAUDE.md, skills, agents, plugins manifest, user-scope MCP servers). Everything is derived
from [docs/research/claude-code-storage.md](../research/claude-code-storage.md) (Claude Code 2.1.247) and the
decisions in [ADR-0004](../architecture/adr/0004-claude-project-matching.md),
[ADR-0005](../architecture/adr/0005-path-remapping.md) and
[ADR-0008](../architecture/adr/0008-restore-transactions-and-collisions.md).

The Claude config directory is always `ctx.claudeConfigDir` (`$CLAUDE_CONFIG_DIR` or `~/.claude`) and
`~/.claude.json` is `ctx.claudeJsonPath`; nothing is hard-coded.

## What is captured

### Per project (`scanProject`)

| Artifact id (`claude-code:<projectId>:…`) | Source                                                                      | Kind          | Sensitivity      | Default      | Notes                                                                                                                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------- | ------------- | ---------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions:<dirName>` (one per match)      | `projects/<dirName>/<sid>.jsonl` + `projects/<dirName>/<sid>/` dirs         | file-set      | safe             | on¹          | Transcripts + `subagents/`, `tool-results/`, `workflows/`. Weak (name-only) matches are off by default.                                                                                                             |
| `memory:<dirName>`                        | `projects/<dirName>/memory/`                                                | directory     | safe             | on           | Auto memory (keyed by the git root; never under worktree dirs).                                                                                                                                                     |
| `file-history`                            | `file-history/<sid>/` for matched sessions                                  | file-set      | safe             | on           | Checkpoint blobs needed by `/rewind`.                                                                                                                                                                               |
| `session-env`                             | `session-env/<sid>/` for matched sessions                                   | file-set      | safe             | on           | Hook-generated env scripts (small; regenerated when missing).                                                                                                                                                       |
| `history`                                 | `history.jsonl` rows whose `project` is the project or one of its worktrees | json-fragment | safe             | on           | Rows are copied verbatim into the payload.                                                                                                                                                                          |
| `claude-json:project`                     | `~/.claude.json` → `projects[<path>]` for the project + worktrees           | json-fragment | safe             | on           | `mcpServers[*].env` / `headers` are stripped.                                                                                                                                                                       |
| `claude-json:mcp-env`                     | the stripped `env` / `headers` blocks                                       | json-fragment | sensitive        | **off**      | "MCP server environment values may contain tokens". Only restorable together with `claude-json:project`.                                                                                                            |
| `project-file:<rel>`                      | `<project>/.claude/settings.local.json`, `<project>/CLAUDE.local.md`        | file          | safe             | on           | Always offered (conventionally gitignored).                                                                                                                                                                         |
| `project-file:<rel>`                      | other files under `<project>/.claude/**` that Git does **not** carry        | file          | safe             | on           | Decided with `git check-ignore --no-index -z --stdin` (one call). Tracked / untracked-not-ignored files are skipped ("captured by Git working tree state"). `.claude/worktrees/` and `*.lock` are never considered. |
| `project-file:.mcp.json`                  | `<project>/.mcp.json` when ignored or not a git repo                        | file          | safe / sensitive | on / **off** | Classified with the core secret classifier (`headers` / `env` → sensitive, off by default).                                                                                                                         |

¹ Transcripts are stored in plaintext by Claude Code; the backup is encrypted. They stay `safe`/on because
migrating sessions is the point of the tool — the reason is shown in the Security Review.

Summary lines: `N sessions`, `project memory`, `CLAUDE.local.md`, `.claude/settings.local.json`,
`N orphaned worktree session sets` (warn), `N weak matches need review` (warn), `N files under .claude are carried by Git`.

### User-wide (`scanGlobal`, ids `claude-code:global:…`)

| Artifact id                                     | Source                                                                                                                                                                                                                                              | Sensitivity | Default | Notes                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `settings`                                      | `settings.json`, `settings.local.json`, `keybindings.json`                                                                                                                                                                                          | safe        | on      |                                                                                                        |
| `claude-md`                                     | `CLAUDE.md`, `rules/`                                                                                                                                                                                                                               | safe        | on      | `@` imports with absolute paths are not rewritten (warned in docs).                                    |
| `skills`                                        | `skills/` **excluding** `skills/synced/`                                                                                                                                                                                                            | safe        | on      |                                                                                                        |
| `agents`, `output-styles`, `commands`, `themes` | the respective directories, when present                                                                                                                                                                                                            | safe        | on      |                                                                                                        |
| `statusline`                                    | `statusline-command.sh`                                                                                                                                                                                                                             | safe        | on      |                                                                                                        |
| `plugins-manifest`                              | `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, `plugins/data/`                                                                                                                                                                | safe        | on      | `plugins/cache/` and `plugins/marketplaces/` are never copied — plugins are re-fetched by Claude Code. |
| `claude-json:user`                              | `~/.claude.json` top-level `mcpServers` (env/headers stripped) + global config keys (`autoConnectIde`, `autoInstallIdeExtension`, `diffTool`, `externalEditorContext`, `permissionExplainerEnabled`, `teammateDefaultModel`)                        | safe        | on      |                                                                                                        |
| `claude-json:user-mcp-env`                      | env/headers of user-scope MCP servers                                                                                                                                                                                                               | sensitive   | **off** |                                                                                                        |
| `credential:oauth-account`                      | `~/.claude.json` → `oauthAccount`                                                                                                                                                                                                                   | credential  | never   | Not selectable: "Re-authenticate on the destination Mac".                                              |
| `credential:sessions-keys`                      | `sessions/*.key`                                                                                                                                                                                                                                    | credential  | never   |                                                                                                        |
| `credential:keychain`                           | Keychain item "Claude Code-credentials" (macOS)                                                                                                                                                                                                     | credential  | never   |                                                                                                        |
| `ephemeral:<dir>`                               | `sessions/`, `shell-snapshots/`, `security/`, `telemetry/`, `cache/`, `ide/`, `paste-cache/`, `backups/`, `debug/`, `tasks/`, `plans/`, `image-cache/`, `uploads/`, `todos/`, `statsig/`, `logs/`, `usage-data/`, `feedback-bundles/`, `downloads/` | —           | never   | Listed with sizes for transparency only (`scope: ephemeral`, not selectable).                          |

## What is excluded and why

- **Identity and credentials**: `oauthAccount`, `userID`, `machineID`, Keychain item, `sessions/*.key`. Never
  written; the restore always adds the attention item "Claude Code authentication required".
- **MCP env/headers** (project-local and user scope): opt-in, sensitive. When not restored the report says
  "MCP server env values need to be re-entered: <servers>".
- **Ephemeral / machine-bound directories** (research §14): regenerated by Claude Code.
- **Plugin caches**: absolute `installPath`s and per-machine builds; re-fetched from the manifest.
- **`paste-cache/`**: plaintext pastes; not migrated in v0.1 (rows in `history.jsonl` that reference pastes lose
  the pasted body).
- **`githubRepoPaths`, usage counters, feature caches** of `~/.claude.json`.
- Files under `<project>/.claude/` that Git carries (tracked, or untracked and not ignored) — the Git provider
  owns them.

## Matching algorithm (ADR-0004)

`ClaudeProjectResolver.resolve(project, ctx)`:

1. Enumerate `<claudeConfigDir>/projects/*`. For each directory list `<sid>.jsonl` transcripts and sample the 5
   most recent ones (up to 200 records each) for `cwd`, `version` and worktree records. Also collect the keys of
   `~/.claude.json` → `projects` and a `sessionId → project` map from `history.jsonl`.
2. Relate every observed `cwd` to the project: `exact` (equals the project's real/canonical path), `child`,
   `worktree` (equals a registered `project.git.worktrees` path), `worktree-child`, `claude-worktree` (under
   `<project>/.claude/worktrees/`), or `none`.
3. Confidence:
   - **exact** — some cwd equals the project path (`kind: project`).
   - **strong** — every cwd is related (child / worktree / Claude worktree), or the directory name reproduces
     `encodeProjectDirName(<project or worktree path>)` and at least one cwd agrees, or `~/.claude.json` /
     `history.jsonl` attribute the directory to a related path. Mixed related/unrelated cwds without corroboration
     are downgraded to weak.
   - **weak** — name-only match (empty or cwd-less transcripts) → `includedByDefault: false`.
   - A directory whose name matches but whose transcripts ran elsewhere is **not** attributed (warning).
4. Kind: `claude-worktree` when any cwd/name points under `.claude/worktrees/`, else `worktree` when it points at a
   registered worktree, else `project`.
5. Dedupe across all selected projects: a directory belongs to exactly one project — the highest confidence wins,
   ties go to the deepest path. Both projects get a `CLAUDE_PROJECT_AMBIGUOUS: …` warning (never a throw).

The encoding rule (`[^A-Za-z0-9] → '-'`) is verified on the source at backup time
(`index.json.encoding`, `restoreHints.claudeEncodingVerified/Samples`) and again on the destination during
planning (preflight `claude-encoding`). Names longer than 200 characters are never guessed: when the path is
unchanged the original directory name is reused verbatim, otherwise the truncated name is used and the outcome is
marked unverifiable.

## Payload layout (schema v1)

```text
<staging>/index.json                     { schemaVersion, section, claudeCodeVersions, encoding, matches[], sessionCount, memoryDirs, fileHistorySessionIds, mcpEnvServersExcluded, project }
<staging>/sessions/<dirName>/<sid>.jsonl + <sid>/…
<staging>/memory/<dirName>/…
<staging>/file-history/<sid>/…
<staging>/session-env/<sid>/…
<staging>/history.jsonl                  (filtered rows, verbatim)
<staging>/claude-json.json               { projects: { <oldPath>: entry-without-env }, mcpEnv?: { <oldPath>: { <server>: { env, headers } } } }
<staging>/project-files/<relative path>
<staging>/settings/…, claude-md/…, skills/skills/…, agents/agents/…, output-styles/…, commands/…, themes/…, statusline/…, plugins/plugins/…   (global section; `<artifactDir>/<entry relative to claudeConfigDir>`)
<staging>/claude-json-user.json          { mcpServers (stripped), config }
<staging>/claude-json-user-mcp-env.json  { mcpServers: { <name>: { env, headers } } }
```

## Path remapping (ADR-0005)

Only these structured fields are rewritten, via `ctx.mapPath` (exact or child paths of a mapping):

```
cwd · relocatedCwd · trackingPath (only when absolute)
worktreeSession.originalCwd · worktreeSession.preEnterOriginalCwd · worktreeSession.worktreePath
backup.realParentDir · snapshot.trackedFileBackups.<rel>.realParentDir
toolUseResult.{filePath, file.filePath, originalFile, outputFile, persistedOutputPath, scriptPath, transcriptDir, worktreePath, originalCwd}
```

`message` (prose, tool inputs, tool results in `message.content`) and every other string are never touched —
verified byte-for-byte by `verify`. Untouched records and invalid lines are copied verbatim; rewritten records are
re-serialised with `JSON.stringify` (key order preserved). Unknown top-level string keys that point into an old
path are reported as `unsupportedReferences` and left unchanged. The same rules apply to subagent transcripts.
Additionally: `history.jsonl` `project`, and the key of `~/.claude.json` → `projects[…]` entries move to the new
path. Session directory names are re-encoded from the **new** cwd.

The remap report lists `Claude sessions` (all sessions when the path changed), `Claude project entries`,
`history entries`, and `safeRewriteCount` = number of path fields found in the payload (bounded to 50,000 records).

## Preflight checks

| id                | Status                                                                                 | Blocking |
| ----------------- | -------------------------------------------------------------------------------------- | -------- |
| `claude-data-dir` | warn when `claudeConfigDir` does not exist yet ("will be created")                     | no       |
| `claude-running`  | warn when `sessions/*.json` lists a live pid (strongly worded: quit Claude Code first) | no       |
| `claude-encoding` | warn when existing destination directories do not follow the expected encoding         | no       |

## Collisions and merge rules (ADR-0008)

| Destination                                                        | Kind                    | Policies (default first)         | Merge semantics                                                                                                                                                                 |
| ------------------------------------------------------------------ | ----------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects/<enc(newCwd)>` has transcripts                           | `claude-project-exists` | merge, skip                      | Add-only by session id. Identical transcript → skipped. Different → written as `<sid>.devmig-conflict.jsonl` + warning. Session dirs add-only.                                  |
| `projects/<enc>/memory` exists                                     | `directory-exists`      | merge, skip                      | Add missing files only; existing notes kept.                                                                                                                                    |
| `~/.claude.json` → `projects[newPath]` exists                      | `json-entry-exists`     | skip, merge                      | Merge adds missing keys only (deep); existing values win. A copy of the original file is written to `<claudeConfigDir>/devmig-backups/claude.json.<ts>.bak` before every write. |
| project-side file exists                                           | `file-exists`           | skip, backup-then-replace        | Original moved to `<file>.devmig-backup-<ts>`.                                                                                                                                  |
| `settings.json` / `settings.local.json` / `keybindings.json` exist | `file-exists`           | skip, merge, backup-then-replace | Merge = deep add-only (existing keys win).                                                                                                                                      |
| other global files                                                 | `file-exists`           | skip, backup-then-replace        |                                                                                                                                                                                 |
| global directories (`skills/`, `agents/`, …)                       | `directory-exists`      | merge, skip, backup-then-replace | Merge = add missing files only.                                                                                                                                                 |
| `~/.claude.json` exists (user scope)                               | `json-entry-exists`     | merge, skip                      | Adds missing MCP servers and config keys; per-server `json-entry-exists` collisions default to skip.                                                                            |

Always add-only, never a collision: `file-history/<sid>`, `session-env/<sid>`, `history.jsonl` (rows deduplicated
by `(sessionId, timestamp)`; the file is rewritten atomically).

`<sid>.devmig-conflict.jsonl` files (and the transient `<sid>.devmig-incoming.jsonl`) are never treated as sessions
by this provider's scanner, so a later backup of the destination does not carry them; resolve them by hand and
delete the conflict file.

Every file is written atomically (temp file in the destination directory + fsync + rename) and only through the
`ScopedFs` whose roots are the approved destinations (project path, its worktrees, `claudeConfigDir`,
`claudeJsonPath`). Large transcripts are streamed, never buffered.

## Verify

- every listed transcript exists at the destination (conflict files → warn);
- 3 sampled transcripts: no record still carries the old path in `cwd`, `message` JSON is byte-identical to the
  backup, line count matches; records that ran outside the project (after `/cd`) → warn;
- checkpoint blobs count ≥ backup count; `~/.claude.json` entry present under the new path (or "existing entry
  kept"); memory files present; global entries present.

## Resume caveat: exactly one copy

`claude --resume <id>` resolves a session id across projects only when **exactly one** project directory holds
it; a duplicate makes Claude Code report "not found". The provider therefore places each session in exactly one
directory (the re-encoded one) and never copies a transcript to a second location. If you restore the same backup
twice with different destinations, delete the stale copy.

## Known limitations

- `paste-cache/` bodies, `githubRepoPaths`, `agent-memory/`, `workflows/` (user-wide) are not migrated.
- `hasTrustDialogAccepted` is carried with the project entry (you restored your own project); review it if the
  destination should re-confirm trust.
- CLAUDE.md `@` imports, hook commands, `statusLine.command`, `permissions.additionalDirectories` and absolute
  permission rules are copied as text; absolute paths inside them are not rewritten.
- Encoded directory names longer than 200 characters carry an undocumented hash; such session sets are marked
  unverifiable and may need relocating by hand.
- Whether "alphanumeric" is ASCII-only for non-ASCII paths is unverified; the provider assumes ASCII (non-ASCII
  letters become `-`) and the destination preflight would flag a mismatch.
- `.claude/settings.local.json` is looked up in the selected project directory only (not at a differing git root).
- Restoring while Claude Code is running is warned against but not blocked.
- Sessions older than the destination's `cleanupPeriodDays` may be swept by Claude Code; mtimes are not preserved by
  the payload, so raise `cleanupPeriodDays` if you restore old sessions.

## Fixtures

`pnpm fixture:claude --session <real transcript> --out fixtures/claude/<name>` writes a sanitized copy
(`fixtures/claude/sample-session/` was produced from a real 2.1.220 transcript). Raw transcripts are never
committed (`fixtures/local/`, `*.raw.*`, `unsanitized/` are git-ignored).
