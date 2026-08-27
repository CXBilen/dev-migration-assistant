# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Three things are versioned independently: the application (`package.json`), the `.devbackup` container format (`formatVersion` in the manifest), and each provider's payload schema (`providers.<id>` in the manifest).

## [Unreleased]

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

