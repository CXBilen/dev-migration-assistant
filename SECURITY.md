# Security Policy

Dev Migration Assistant handles some of the most sensitive data on a developer's machine: source code, Claude Code
transcripts (which may echo secrets), env files and Git working state. Security reports are taken seriously and
handled privately.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

- Preferred: open a private report via
  [GitHub Security Advisories](https://github.com/CXBilen/dev-migration-assistant/security/advisories/new).
- If that is not possible, contact the maintainer through the e-mail address listed on the
  [maintainer's GitHub profile](https://github.com/CXBilen) with the subject `[dev-migration-assistant] security`.

Include: affected version (`Diagnostics → Copy` in the app, or the git commit), a description, reproduction steps or
a proof-of-concept `.devbackup` if relevant, and the impact you believe it has. Please do **not** include real secrets,
real transcripts or real repositories — construct a minimal fixture instead.

You can expect an acknowledgement within **7 days** and a status update within **14 days**. Confirmed issues are
fixed in a patch release and credited in the changelog unless you prefer to stay anonymous. There is no bug bounty.

## Supported versions

| Version              | Supported                          |
| -------------------- | ---------------------------------- |
| latest `0.x` release | yes                                |
| older `0.x` releases | no — upgrade to the latest release |

## Scope

In scope:

- The `.devbackup` container: confidentiality and integrity of encrypted backups, password handling, KDF parameters,
  tamper and truncation detection.
- Restore hardening: path traversal, symlink/hardlink escapes, writes outside approved destinations, decompression
  bombs, manifest manipulation, size/count limits.
- Command execution: any way to inject arguments or shell into `git` or other subprocesses through project content
  (file names, branch names, remote URLs, worktree paths).
- Electron posture: renderer sandbox and context isolation, IPC validation and sender checks, navigation lockdown,
  CSP, fuses in release builds.
- Secret handling: credentials being migrated, secrets appearing in logs, diagnostics or error messages.
- Data safety: any operation that modifies source data during backup, or writes to unapproved paths during restore.

Out of scope:

- Attacks that require the attacker to already control the user's macOS account with the app running (a local
  attacker with your login can read `~/.claude` directly).
- Weak passwords chosen by the user (the KDF is memory-hard, but a 6-character password is still a 6-character
  password; the app enforces a minimum of 8).
- Vulnerabilities in Claude Code, Git or macOS themselves — report those upstream.
- Denial of service against your own machine by feeding the app a huge backup you created yourself.

## Security design

The design is documented in [`docs/security/THREAT_MODEL.md`](docs/security/THREAT_MODEL.md) (assets, trust
boundaries, attacker models, threat → mitigation table) and in the ADRs:

- [ADR-0003](docs/architecture/adr/0003-devbackup-container.md) — the encrypted container.
- [ADR-0007](docs/architecture/adr/0007-electron-security-posture.md) — Electron security posture.
- [ADR-0008](docs/architecture/adr/0008-restore-transactions-and-collisions.md) — restore transactions.

Key properties in one paragraph: everything is local (no network code paths for user data); backups are encrypted
with Argon2id + AES-256-GCM by default; credentials are never migrated; sensitive files are excluded unless the user
opts in; the backup file is treated as untrusted on restore; no data is written before the user approves a plan, and
then only through a scoped filesystem bound to the approved destinations; the renderer is sandboxed behind a typed
IPC whitelist; subprocesses only ever receive argument arrays.

## Release integrity

Release DMGs are built by GitHub Actions from a tagged commit
([`.github/workflows/release.yml`](.github/workflows/release.yml)). Each release attaches a `SHA256SUMS.txt`; verify
your download with `shasum -a 256 -c SHA256SUMS.txt`. v0.1 builds are **unsigned**; signed and notarized builds are
planned (see [`docs/release/RELEASE.md`](docs/release/RELEASE.md)). If you prefer, build from source with
`pnpm dist:mac`.
