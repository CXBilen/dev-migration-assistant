# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Three things are versioned independently: the application (`package.json`), the `.devbackup` container format (`formatVersion` in the manifest), and each provider's payload schema (`providers.<id>` in the manifest).

## [Unreleased]

### Added

- Every backup now records a **capability snapshot** (`manifest.capabilities`): developer tools with
  version, resolved path and install method, the search path used, and the Claude Code versions that
  wrote the transcripts. Names and paths only — never credentials, env values or account details.
- Diagnostics lists the developer tools it found (version, path, install method) and the directories
  it searches.

### Changed

- The app resolves a deterministic search path (launchd `PATH` + `/etc/paths(.d)` + the well-known
  user tool directories that exist) instead of relying on the environment it was launched with. A
  Finder-launched build previously reported `claude`, `gh`, `brew`, `node` and `pnpm` as _not
  installed_ when they lived in `~/.local/bin` or `/opt/homebrew/bin`. No login shell is spawned.
- The remediation catalogue moved to `@devmig/core` (`Remediation` type in `@devmig/model`); the
  `nvm install` suggestion (a shell function) became `brew install node@<major>`, and the invalid
  `brew install npm` became `brew install node`.

### Security

- MCP server definitions in `~/.claude.json` whose `args` or `url` carry a secret-looking value
  (e.g. `API_KEY=…` inline) now make the corresponding artifact **sensitive and opt-in**; previously
  they were included as safe.
- `session-env/` scripts (hook-generated per-session environment files, which hooks may fill with
  secrets) are no longer backed up or restored; they are listed as ephemeral and Claude Code
  regenerates them.
- Git remote URLs are stored without embedded credentials — in the manifest and in the Git provider's
  `repository.json` — and are restored without them (`https://user:token@…` → `https://…`); sign in again
  through your credential helper on the destination.

## [0.1.0-alpha.6] - 2026-08-28

### Added

- Backup Review: **Select everything** picks every selectable item at once (sensitive files, weak Claude Code
  matches, hidden-by-default state when ephemeral items are shown). When that would include sensitive files or
  weak matches, a confirmation dialog lists them first; credentials are never included.

### Fixed

- Backup failed with `payloadPath "…/claude-code/sessions/<dir>" does not exist in the staging directory` when a
  Claude Code project directory (typically a stale `.claude/worktrees/…` leftover) contained no transcripts. Such
  directories are no longer offered as "sessions (0)", and the sessions payload directory is always created even
  when nothing could be copied.

## [0.1.0-alpha.5] - 2026-08-28

**First functional build.** The Electron bridge is wired, so Create Backup and Restore Backup now operate on your
real projects and Claude Code data (read-only during backup; restore writes only to the destinations you approve).

### Added

- Electron main process: hardened window and web-contents lockdown, deny-all permission handler, single instance,
  redacted file logging, typed IPC router (trusted-sender check, zod validation of every request and response, error
  envelopes), native folder/file/save dialogs, job progress streaming, diagnostics, stale-staging sweep on startup.
- Preload bridge `window.devMigration` with per-channel wrappers only (no `ipcRenderer`, no Node, no generic invoke).
- Playwright Electron E2E suite (smoke, full backup, full restore with path remap, wrong password, cancellation)
  driven through an inert-unless-enabled dialog seam.
- Definition-of-Done migration test: a fake "Mac A" (Git repo with worktree, staged/unstaged/binary/untracked
  changes, Claude sessions, memory, checkpoints, `~/.claude.json`, `.env.local`) is backed up and restored as a
  different user at a different path on a fake "Mac B" through the real providers and the real container; asserts
  Git equivalence, session placement, rewritten `cwd`, untouched prose and excluded secrets (9 scenarios).
- Electron fuses on packaged builds (RunAsNode off, NODE_OPTIONS off, inspect off, ASAR-only, integrity validation)
  and a strict production CSP.

### Security

- `backups:create` only accepts output paths that came from the app's own save dialog; restore destinations must be
  absolute and under the home directory, `/Users` or `/Volumes` (or chosen through the app's dialog).
- `system:openExternal` is limited to https links to an allow-list of hosts.

## [0.1.0-alpha.4] - 2026-08-28

### Changed

- The DMG volume icon is the app icon itself.

## [0.1.0-alpha.3] - 2026-08-28

Packaging polish for the UI preview; no functional change in the app itself.

### Changed

- App icon and DMG volume icon are rendered with real transparency (no white box on the Dock, in Finder or QuickLook).
- DMG: Retina-ready background (1× + 2× HiDPI TIFF) with a refined layout — header, dotted guide arrow, install hint
  with the Gatekeeper "Open Anyway" flow, and Local only / Encrypted / Open source badges; external-disk style volume icon.
- `docs/release/RELEASE.md` is now tracked (it was hidden by an over-broad ignore pattern), so the CI docs checks pass.

## [0.1.0-alpha.2] - 2026-08-28

Still a **UI preview** (the renderer runs on built-in preview data; the Electron bridge to the engines is in progress),
but the build and the repository are in much better shape.

### Added

- Core engines on `main`: project scanner, migration planner, path remapper (prefix- and worktree-aware), secret
  classifier, machine-info collector, backup engine (staging → checksums → encrypted container → verify) and restore
  engine (extract → validate → map paths → preflight/collisions → provider restore → verify → report), with 124 unit
  and 24 integration tests. `pnpm verify` is green end-to-end (510 unit + 65 integration tests).
- Provider, renderer and docs audit follow-ups (threat model aligned with the implemented container).

### Changed

- macOS builds without a signing identity are now **ad-hoc signed**: Gatekeeper offers "Open Anyway" instead of
  reporting the app as damaged.
- DMG: HiDPI drag-and-drop background, a disk-image style volume icon, `Applications` shortcut.
- The app icon is used in the app's sidebar; README gained diagrams, screenshots and a "Why you can trust it" section.

## [0.1.0-alpha.1] - 2026-08-28

**UI preview.** An unsigned arm64 DMG to look at the product flows. The renderer runs on built-in preview data until the
Electron bridge to the engines ships in the next alpha — nothing on your machine is read or written by this build.

### Added

- Domain model, provider contract, job engine and core service API (`@devmig/model`, `@devmig/core`).
- `.devbackup` container: Argon2id + chunked AES-256-GCM, streaming pack/extract/verify, hardened extraction, format spec.
- Providers: Claude Code (metadata-driven session matching, schema-aware path remap, add-only merges), Git (bundle +
  per-worktree staged/unstaged/untracked deltas, logical worktree reconstruction), project files, runtime manifest.
- React renderer: Home, 6-step Create Backup wizard, 6-step Restore wizard, Settings, Diagnostics — light/dark, keyboard
  accessible, preview-data mode.
- Test fixtures (fake "Mac A" → "Mac B" machines), 400+ unit/integration tests, docs consistency tests.
- Open-source packaging: README, CONTRIBUTING, SECURITY, Code of Conduct, threat model, provider authoring guide,
  release process, user guide, roadmap, known limitations, CI and release workflows.

### Not yet in this build

- The Electron main/preload bridge (native dialogs, IPC, job streaming) — the UI shows a "Preview data" badge.
- End-to-end Definition-of-Done migration test and Playwright E2E.
- Code signing / notarization (see docs/release/RELEASE.md).

