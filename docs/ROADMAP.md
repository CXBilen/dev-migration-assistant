# Roadmap

This roadmap describes intent, not commitments. Items move between releases as we learn from real migrations.
Provider additions follow the process in [`docs/providers/AUTHORING.md`](providers/AUTHORING.md) and are the
easiest place to contribute.

## v0.1 — the core loop (current)

- macOS 13+, Apple Silicon, unsigned DMG.
- Providers: Claude Code, Git, project files, runtime facts.
- Encrypted `.devbackup` (Argon2id + chunked AES-256-GCM), streaming everywhere, hardened extraction.
- Restore plan with collisions, preflight, path-remap report; write only through `ScopedFs`.
- Metadata-driven Claude Code project matching; schema-owned path rewriting only.
- Definition of done: fake Mac A → fake Mac B with a changed username and project path, `claude --resume` works.

## v0.2 — more tools, smoother installs

**Providers**

- **Codex CLI** — sessions, config, MCP; credentials excluded; `cwd` remap.
- **Cursor** — workspace storage and per-project state keyed by path; chat history where it lives on disk;
  extensions list as a manifest to reinstall, not a copy.
- **VS Code** — `settings.json`, `keybindings.json`, snippets, workspace storage for selected projects, extensions
  manifest (`code --list-extensions`) with reinstall on restore.

**Container and security**

- **Recovery key**: a second, randomly generated key wrapping the master key so a forgotten password does not mean
  a lost backup (printed once at backup time; header gains a second wrap stanza — `formatVersion` 2).
- **Compression** inside the encryption (`payload.compression: gzip`, capped decompression in our pipeline).
- Password strength meter and top-list blocking in the Backup Wizard.

**Distribution**

- **Universal build** (arm64 + x64) once Intel users appear.
- **Signed and notarized releases** (Developer ID, hardened runtime, stapled ticket) — the workflow already
  supports it; it only needs the certificate secrets.
- Homebrew cask.

**Quality**

- Fixture generator (`pnpm fixture:claude`) producing sanitised, committed Claude Code fixtures from a real machine.
- Larger E2E matrix: collision policies, cancellation, wrong password, tampered file.

## v0.3 — the rest of the machine

- **Homebrew** provider: `Brewfile`-style manifest (formulae, casks, taps) captured on backup; on restore the app
  shows what is missing and offers the `brew bundle` command — never installs silently.
- **Node runtimes**: `.nvmrc`/`.node-version`/`.tool-versions` per project plus the global version manager state as
  a manifest (nvm, fnm, volta, mise); restore reports what to install.
- **Docker**: named volumes and compose project state for selected projects (opt-in, sizes shown up front).
- **Ghostty** and other terminal configs as user-scoped artifacts.
- Selective restore of individual sessions; search inside a backup's manifest.
- Scheduled/incremental backups (append-only session deltas).

## v1.0 — Mac → Mac direct transfer

- **Direct transfer** between two Macs on the same network or via Thunderbolt/USB-C: the source streams the
  encrypted payload to the destination app, which plans and restores on the fly — no intermediate file, same
  container format on the wire, same plan/approval flow.
- Pairing with a short code shown on both screens; mutual authentication; no cloud relay.
- Windows/Linux **restore** of the container (read-only tooling) if demand exists; full cross-platform providers
  are out of scope until path semantics are settled.
- Stable `formatVersion`, documented compatibility policy, signed releases as the default.

## Explicitly not planned

- Cloud sync, accounts, telemetry or any network code path for user data.
- Migrating credentials (Keychain items, OAuth tokens). Re-authentication on the destination stays a feature.
- Global find-and-replace of paths inside conversation text.
- Copying `.git/worktrees` metadata or Claude Code's plugin cache verbatim.
