# User guide: moving your projects from one Mac to another

This is the real procedure, end to end, for the situation the app was built for: you have been working on a
**MacBook Air**, you bought a **Mac mini**, and you want your projects to be _exactly_ where you left them —
branches, uncommitted changes, worktrees, Claude Code conversations, memory, settings and local config — even
though the new machine has a different username and you want the projects in a different folder.

> Written against the 1.0 release. Anything described as "the app checks" or "the app refuses" is enforced in the
> core engines, not just in the UI.

**Time needed:** 10–30 minutes of your attention plus copy time. **Network needed:** none for the migration
itself; only for re-authenticating on the new Mac.

---

## 0. Before you start

**On the MacBook Air (source)**

- Dev Migration Assistant installed ([README → Install](../README.md#install)).
- `git` installed (it is, if you have been working there).
- Know which project folders you want to move. Worktrees are picked up automatically when you select the main
  checkout; you do not need to select them separately.

**On the Mac mini (destination)**

- macOS 13 or newer, Apple Silicon.
- Enough free disk space for the projects **plus** the backup file while you restore.

**Something to carry the file:** AirDrop, an external SSD, or any other file transfer. The `.devbackup` is
encrypted, so the transport does not need to be trusted — but it does need to carry a single file that may be
several gigabytes (see the FAT32 note in [§2](#2-transfer-the-devbackup)).

**Keep the source Mac intact until [§5](#5-verify-on-the-mac-mini) passes.** The app never modifies the source,
and the safest fallback is a machine you have not wiped yet.

---

## 1. Create the backup on the MacBook Air

1. **Quit Claude Code** in the projects you are about to back up (`/exit` or close the terminal). Backup is
   read-only and works with Claude running, but quitting makes sure the last transcript records are flushed to
   disk so the newest conversation turns are in the backup.
2. Open **Dev Migration Assistant → Create Backup**.
3. **Add project folders.** Use the native folder picker; multi-select works. Pick the main checkout of each
   repository (for example `~/Documents/GitHub/looplift`). The scan discovers registered worktrees, including
   Claude-managed ones under `<project>/.claude/worktrees/`.
4. **Scan.** Read the per-project summary. You should see lines such as:
   - Git: `✓ main @ abc1234`, `! 4 modified files`, `2 worktrees`, `1 remote`
   - Claude Code: `Claude Code sessions (187)`, `auto memory`, `project settings`, `CLAUDE.md`
   - Project files: `.env.local` marked **sensitive**, off by default
   - Global Claude Code environment (user settings, `~/.claude/CLAUDE.md`, MCP servers, prompt history)

   If a project shows no Claude sessions but you expect some, check that you selected the folder Claude Code
   was actually started in (the matching is evidence-based — see [ADR-0004](architecture/adr/0004-claude-project-matching.md)).

5. **Security review.** Sensitive artifacts are excluded by default. Decide deliberately:
   - `.env.local` and friends: include them only if you want them on the new Mac. They stay encrypted in the
     backup either way, but a backup file is one more copy of your secrets.
   - MCP server configuration with `env`/`headers` blocks: same rule.
   - Credentials (Claude OAuth account block, Keychain items, session keys) are **not selectable**. You will
     sign in again on the Mac mini. That is intentional.
6. **Password and label.** Choose a long passphrase (minimum 8 characters; a sentence you can remember is
   better than a short random string). **There is no password recovery in 1.0** — a forgotten password means an
   unreadable backup. Give the backup a label such as `air-to-mini`.
7. **Output path.** The app suggests a file name in a sensible folder; save it anywhere you can copy from
   (Desktop is fine).
8. **Create.** Phases run `COLLECTING → PACKING → ENCRYPTING → VERIFYING → COMPLETE`. In `VERIFYING` the app
   re-reads the finished file and checks every encrypted chunk and every file checksum. Wait for `COMPLETE`;
   the summary shows the file size, project count, session count and worktree count.

Optional, recommended if the file is going onto a drive you will hand to someone else: **Diagnostics → Verify a
backup file** streams through the file once more (every encrypted chunk and every checksum) without extracting
anything.

---

## 2. Transfer the `.devbackup`

Any of these works; the file is encrypted and integrity-protected, so a damaged copy will be detected on the
other side rather than silently restored.

- **AirDrop:** Finder → right-click the `.devbackup` → Share → AirDrop → pick the Mac mini. Accept on the mini;
  the file lands in `~/Downloads`.
- **External SSD / USB drive:** copy the file, eject properly. If the drive is formatted **FAT32/MS-DOS**, files
  larger than 4 GiB cannot be written — reformat as APFS or exFAT, or use AirDrop.
- **Network share / any cloud folder:** fine as well; the file does not need a trusted transport.

Sanity check on the mini (optional): the byte size shown in Finder matches the source, or
`shasum -a 256 <file>` matches on both machines.

---

## 3. Prepare the Mac mini

Install the tools **before** restoring so the restore plan's preflight checks pass and so the verification step
can exercise them.

1. **Git.** Run `git --version` in Terminal. If macOS offers to install the Command Line Tools, accept
   (`xcode-select --install`), or install with Homebrew.
2. **Claude Code.** Install it following Anthropic's current instructions, then start `claude` once in any
   directory and sign in when prompted (`/login` inside the session). This creates `~/.claude` and
   `~/.claude.json` with your account and makes sure the version on the mini can read the transcripts you are
   about to restore. **Quit Claude Code afterwards** — the restore plan warns while a session is running,
   because Claude Code rewrites `~/.claude.json` and transcripts in the background and could overwrite what
   was just restored.
3. **GitHub CLI** (if you use it): `brew install gh`. Do not sign in yet; that comes after the restore.
4. **Dev Migration Assistant.** Install the DMG. 1.0 builds are ad-hoc signed but not notarized, so on first launch use
   right-click → **Open**, or `xattr -d com.apple.quarantine "/Applications/Dev Migration Assistant.app"`
   (details in the [README](../README.md#install)).
5. **Decide where projects should live.** For example `~/Code` instead of the Air's `~/Documents/GitHub`. The
   folder can be empty or absent; the app creates project directories inside it. Projects on network volumes
   or iCloud Drive are not supported for Claude Code worktrees (Claude Code refuses network-path worktrees).

---

## 4. Restore on the Mac mini

1. Make sure **no `claude` process is running** (`pgrep -fl claude` should print nothing; also close editor
   extensions that launch Claude Code).
2. Open **Dev Migration Assistant → Restore Backup** and pick the `.devbackup`. The app first reads the
   unencrypted header (format version, KDF parameters) and tells you if the file is unsupported or corrupt.
3. **Enter the password.** A wrong password fails immediately at key unwrap; nothing else is read.
4. **Inspect.** The manifest shows the source machine (username, home directory, tool versions), every project
   with its original path, session counts and sizes.
5. **Map paths.** For each project choose the new location. The default is derived from your new home
   directory (`/Users/<old>/Documents/GitHub/looplift → /Users/<new>/Code/looplift` if you picked `~/Code`).
   Worktrees follow their project automatically (`../looplift-onboarding` stays `../looplift-onboarding`
   relative to the new path). The **remap report** shows what will be rewritten, for example
   `187 sessions require safe path remapping · ✓ safe automatic remap`, and lists anything the app does not
   know how to rewrite under _unsupported references_ (those are preserved verbatim and reported, never
   guessed).
6. **Review the restore plan.** Nothing has been written yet. The plan lists:
   - **Steps** with the real destination path of each (`git clone` from bundle, `git worktree add`, apply staged
     and unstaged diffs, copy untracked files, restore Claude sessions, merge `~/.claude.json` entries, copy
     env files).
   - **Preflight checks** — `git` present, destination writable, enough free space (1.2 × the payload), bundle
     and branch names valid, provider schema versions understood (all blocking), plus warnings such as
     _Claude Code not running_ and _project directory encoding verified_. A blocking failure disables the
     Restore button; fix it and re-plan. Treat the Claude Code warning as blocking anyway: quit and re-plan.
   - **Collisions** — every existing destination file, repository, worktree path or Claude project directory,
     each with a non-destructive default of **skip**. Change a collision to **merge** (Claude sessions are added
     by session id, `~/.claude.json` entries and history are add-only), **backup-then-replace** (the original is
     moved to `<path>.devmig-backup-<timestamp>`), or **alternate path**. The app never guesses when a merge
     would be ambiguous; it asks.
7. **Restore.** Phases run
   `STAGE → RESTORE_REPOSITORIES → RESTORE_WORKTREE_STATE → RESTORE_CLAUDE → RESTORE_PROJECT_FILES → VERIFY → REPORT`.
   Writes go only to the destinations you approved. Files are written atomically, so cancelling leaves either
   the old file or the complete new one, never a torn one.
8. **Read the report.** Per project and provider: `ok` / `partial` / `skipped`, the verification checks
   (`git status` matches the captured state, worktrees listed, session files present and parseable, path
   remap applied), and the **attention list** — re-authenticate Claude, re-authenticate GitHub, tools that were
   on the Air but are missing here (with versions from `machine.json`).

---

## 5. Verify on the Mac mini

Do this for at least one project before you trust the migration.

```sh
cd ~/Code/looplift                 # the new path you mapped

git status                          # same branch, same staged/unstaged/untracked files as on the Air
git worktree list                   # every worktree, at its new location
git remote -v                       # origin re-added from the backup metadata
git log --oneline -3                # history intact (from the bundle; no network needed)
git stash list                      # expected to be empty: stashes are not migrated in 1.0
```

Then Claude Code:

```sh
claude --resume                     # the picker lists this project's sessions; open one and scroll back
```

Inside the session, `/memory` should show your `CLAUDE.md` hierarchy and auto-memory files, and
`claude mcp list` (from the shell) should show the MCP servers you migrated. If you restored a worktree session,
`claude --resume` from inside that worktree re-enters it.

Your **workspace trust** decision travels with the restored `~/.claude.json` project entry (it is your own
project). If Claude Code still shows the trust prompt for the new folder, accept it once; if you would rather be
asked again, remove `hasTrustDialogAccepted` from that entry.

---

## 6. Re-authenticate

Nothing in the backup can log you in anywhere. Expect to do all of this once:

| What                   | How                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code            | `claude`, then `/login` if it did not prompt. The OAuth token lives in the macOS Keychain and was never in the backup.                           |
| GitHub CLI             | `gh auth login`. This also configures a git credential helper for HTTPS remotes.                                                                 |
| SSH remotes            | Generate a new key (`ssh-keygen -t ed25519`) and add it to GitHub/GitLab, or copy your keys manually. `~/.ssh` is never part of a backup.        |
| MCP servers with OAuth | Re-authorise from the tool's own login flow; their tokens were not migrated.                                                                     |
| npm, Vercel, AWS, etc. | `npm login`, `vercel login`, `aws configure`, … whatever the project needs. `.env.local` files are back only if you opted them in during backup. |

**Tip — keep old sessions from being swept.** Claude Code deletes transcripts older than `cleanupPeriodDays`
(default **30 days**) in a background sweep after a session starts, and restored sessions keep their original
timestamps. Before your first `claude` launch after the restore, raise the retention period on the mini in
`~/.claude/settings.json` (if you restored your user settings from the Air, check the value is still what you
want):

```json
{
  "cleanupPeriodDays": 3650
}
```

The restore report warns when sessions in the backup are older than the destination's current retention
period.

**Safety copy.** Before touching `~/.claude.json` the app writes a timestamped copy to
`~/.claude/devmig-backups/claude.json.<timestamp>.bak`. If anything about the merged entries looks wrong, that
file is the pre-restore state.

---

## 7. Troubleshooting

**"Dev Migration Assistant can't be opened because Apple cannot check it for malicious software."**
Expected for 1.0 (not notarized). Right-click the app → Open, or remove the quarantine attribute — see
[README → Install](../README.md#install). On macOS 15+ you may instead need System Settings → Privacy & Security
→ **Open Anyway** after the first refusal.

**Wrong password (`ARCHIVE_AUTH_FAILED`).**
The password is exactly what you typed on the Air (Unicode is NFC-normalised, so composed/decomposed accents
do not matter, but keyboard layout and Caps Lock do). There is no recovery key in 1.0. If the password is
lost, the backup cannot be opened; create a new one on the source Mac.

**"Backup file is corrupt / truncated" (`INTEGRITY_MISMATCH`, `ARCHIVE_INVALID`).**
The copy is damaged or incomplete — compare sizes, re-copy, or re-AirDrop. The app fails closed on the first
bad chunk and writes nothing. A backup created with a newer app version than the one installed reports
`ARCHIVE_UNSUPPORTED_VERSION`; update the app on the mini.

**Preflight warning: "Claude Code not running" shows live pids.**
Quit every Claude Code session (including ones started by editor extensions or `claude -p` scripts) and
re-plan. `pgrep -fl claude` shows what is still running. The check reads Claude Code's live session registry
under `~/.claude/sessions/` and probes each recorded pid; a stale entry after a crash is ignored once its
process is gone. In 1.0 the check is a warning, not a hard stop — do not proceed while it shows a pid.

**Preflight: `git` not found (`GIT_NOT_INSTALLED`).**
Install the Command Line Tools (`xcode-select --install`) or Homebrew git, restart the app, re-plan.

**`claude --resume` shows no sessions for the project.**

1. Run it from the exact restored path (`pwd` must equal the path you mapped; `/Users/...` and a symlinked
   alias are different directories to Claude Code).
2. Look in `~/.claude/projects/` for a directory whose name encodes the new path (every non-alphanumeric
   character becomes `-`). If the restore report showed a **warn** about the directory-name encoding (paths
   whose encoded name exceeds 200 characters, or an encoding the app could not verify on your machine), the
   sessions were restored under the best-known name and may need to be moved — the report says where they
   are.
3. Check the retention sweep did not remove them: `cat ~/.claude/.last-cleanup` and the `cleanupPeriodDays`
   tip above.
4. Worktree sessions appear in the picker only from inside that worktree (Ctrl+W in the picker shows all
   worktrees of the repository).

**A session opens but Claude Code says "not found" for `--resume <id>`.**
Claude Code refuses to resolve an id that exists in more than one project directory. Do not hand-copy session
files between directories; use the app's merge, which places each session in exactly one directory.

**Collision: "directory exists" / "git repository exists" at the destination.**
Change the collision's policy in the plan: skip (default), merge where offered, backup-then-replace, or pick an
alternate path. Restoring with skip/merge defaults is safe to run twice.

**`git apply` failed for the unstaged or staged diff (`GIT_APPLY_FAILED`).**
The repository is still restored; the working-tree delta could not be applied cleanly (usually because the
destination already had local modifications — pick backup-then-replace or a fresh path). The diff files are
left in `<worktree>/.devmig-unapplied/` so you can inspect them and apply by hand
(`git apply --index --binary .devmig-unapplied/staged.diff`, then `git apply --binary
.devmig-unapplied/unstaged.diff`).

**macOS asks for permission to access Desktop / Documents / a removable volume.**
Grant it; the app reads project folders and backup files only where you point it. If repositories live in a
location that keeps prompting, System Settings → Privacy & Security → Full Disk Access for the app resolves it.

**Disk full (`DISK_FULL`).**
Restore needs space for the staged payload plus the final files. Free space, or restore fewer projects per run.

**Anything else.**
Diagnostics → **Copy** produces a redacted report (versions, provider status, Claude config dir, recent job
events) — paste it into a [bug report](https://github.com/CXBilen/dev-migration-assistant/issues/new/choose).
Diagnostics → **Open logs** shows the log directory. Logs and diagnostics pass through the secret redactor,
but skim them before posting anyway.

---

## Validation

This guide is the human version of the definition-of-done scenario: fake Mac A → fake Mac B with a changed
username and project path, `git status` identical, `claude --resume` finds the sessions.

- validated by: `packages/core/src/**/migration.integration.test.ts` (headless end-to-end migration)
- validated by: `tests/e2e/*.e2e.ts` (the wizard flows in the built app)
