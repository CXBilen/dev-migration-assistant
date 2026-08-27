# @devmig/test-utils

Fixture toolkit shared by every package's tests. Everything is written under a directory the caller
passes in (normally a `makeTempRoot()` under `os.tmpdir()`); every builder refuses the real home
directory and its sensitive subtrees (`assertSafeFixtureRoot`). Nothing here ever reads or writes the
real `~/.claude`, `~/.claude.json`, `~/Documents/GitHub/*` or global git config.

```ts
import {
  createSourceMachineFixture,
  createDestinationMachineFixture,
  makeTempRoot,
} from '@devmig/test-utils'

const tmp = await makeTempRoot('my-test-')
const macA = await createSourceMachineFixture(tmp.root) // alice: dirty repo + worktree + Claude state + .env.local
const macB = await createDestinationMachineFixture(tmp.root) // bob: empty ~/.claude
// ... run scan → backup → plan → restore against macA.home / macB.home ...
await tmp.cleanup()
```

| Area   | Builders                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------- |
| Temp   | `makeTempRoot`, `withTempRoot`, `removeTempTree`, `makeTreeWritable`, `assertSafeFixtureRoot`                    |
| Home   | `createFakeHome(root, { userName })` → `homeDir`, `claudeConfigDir`, `claudeJsonPath`, `projectsDir`, `env`      |
| Git    | `createGitRepoFixture`, `createDetachedHeadRepo`, `createEmptyRepo`, `refreshGitFixtureExpectations`             |
| State  | `captureGitState`, `compareGitState`, `parseWorktreeListPorcelain`, `parseStatusV2`, `splitDiffByFile`           |
| Claude | `encodeClaudeProjectDir`, `createClaudeFixture`, `buildClaudeTranscript`, `readJsonl`, `writeJsonl`              |
| Macs   | `createSourceMachineFixture`, `createDestinationMachineFixture`                                                  |
| Exec   | `createFakeExec(handlers)`, `matchCommand`, `gitTestEnv`, `bindExecEnv`, `assertSafeArg`, `assertSafeBranchName` |
| Ids    | `deterministicUuid`, `isUuidV4`, `seededBytes`                                                                   |

## The git fixture

`createGitRepoFixture({ root, name })` builds `<root>/<name>` with three commits on `main`, a
`feature/onboarding` branch (one extra commit), remote `origin` (never contacted, plus a simulated
`refs/remotes/origin/main`), a linked worktree at `<root>/<name>-onboarding` on `feature/onboarding`,
and this dirty state in the primary checkout:

```text
1 M. … src/index.ts        staged modification
1 A. … src/new-staged.ts   staged new file
1 .M … README.md           unstaged modification
1 .M … assets/logo.png     unstaged binary modification (committed PNG-like blob)
? notes/todo.md            untracked
.env.local                 ignored (API_KEY / DATABASE_URL placeholders — see fixture.secrets)
node_modules/junk.js       ignored
```

The worktree has an unstaged change to `src/onboarding.ts` and an untracked `notes/wt-scratch.md`.
`fixture.expected` / `fixture.worktree.expected` are `captureGitState` snapshots taken right after
creation; compare a restored checkout with `compareGitState(fixture.expected, await captureGitState(dest, exec))`.
Commit dates and identity are fixed, so two fixtures with the same `name` have identical SHAs.

Git runs with `fixture.env` (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, fixed identity,
`HOME` = the fixture root or the fake home). Pass `fixture.env` (or use `fixture.exec`) for every git
call against fixture repositories.

## The Claude fixture

`createClaudeFixture({ claudeConfigDir, claudeJsonPath, projectPath, worktreePaths?, sessionCount?,
includeOrphanWorktreeSession?, otherProjectPath?, createProjectFiles? })` mirrors the layout observed on
a real Claude Code 2.1.247 install (`docs/research/claude-code-storage.md`):

- `projects/<encode(projectPath)>/<sid>.jsonl` × `sessionCount` (default 3), each with a
  `custom-title`, `user`, `assistant` (prose + `tool_use` that contain the absolute path and must never
  be rewritten), `user` with `toolUseResult.{filePath,transcriptDir}`, `file-history-snapshot`,
  `file-history-delta`, `last-prompt`, `permission-mode` record and one `not json` line;
  per-session `<sid>/tool-results/result-1.txt` and `<sid>/subagents/agent-1.jsonl`;
  `memory/MEMORY.md` + `memory/notes.md` under the repo-root project dir only.
- One session per entry in `worktreePaths` (cwd = the existing worktree) and one orphaned worktree
  session under `projects/<encode(projectPath + '/.claude/worktrees/onboarding')>` whose directory does
  not exist on disk (`gitBranch: 'worktree-onboarding'`).
- An unrelated `projects/<encode(otherProjectPath)>/<sid>.jsonl` that must never be matched.
- `file-history/<sid>/{abc123@v1,def456@v1}`, `session-env/<sid>/sessionstart-hook-1.sh`,
  `history.jsonl` (3 rows for the project, 2 for the other project), `settings.json`,
  `settings.local.json`, `CLAUDE.md`, `statusline-command.sh`, `skills/demo-skill/SKILL.md`,
  `agents/reviewer.md`, `plugins/{installed_plugins,known_marketplaces}.json`, ephemeral
  `sessions/12345.json` + `sessions/12345.abc.key`, `shell-snapshots/snapshot-zsh-1.sh`.
- `~/.claude.json` with identity placeholders, `githubRepoPaths`, and `projects[...]` entries for the
  project (with an MCP server whose `env` holds `tok_secret_123`), each worktree, the orphaned worktree
  and the other project.
- Project-side `<projectPath>/.claude/settings.local.json`, `CLAUDE.local.md`, `CLAUDE.md`,
  `.mcp.json`, `.nvmrc`.

Every session is described in `fixture.sessions` (`kind`, `cwd`, `gitBranch`, every path, the message
uuids and the `expectedMatch` a metadata-driven resolver should produce). Ids are deterministic UUID v4
strings derived from the path, so re-running with the same paths reproduces byte-identical files.
