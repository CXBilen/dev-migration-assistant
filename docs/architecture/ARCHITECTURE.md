# Architecture

**Dev Migration Assistant** — _Migration Assistant, but for developers._ Your machine. Your code. Your context.

The app backs up and restores the **real local state of active development projects** between Macs: Claude Code
conversations/sessions and project state, user/project/local Claude settings, `CLAUDE.md` files, MCP configuration,
local environment files, Git working-tree state (staged, unstaged, untracked, binary), branches, and worktrees.

Everything runs locally. No account, no server, no telemetry, no cloud upload. Backups are encrypted by default.

## Logical architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                     ELECTRON APPLICATION                     │
│  Renderer / React  ── Backup Wizard · Restore Wizard ·       │
│                       Project Inspector · Progress + Reports │
│            │ typed, zod-validated IPC (no generic tunnel)    │
│  Preload   ── narrow contextBridge API: window.devMigration  │
│            │                                                 │
│  Main      ── IPC controllers · native dialogs · permission  │
│               boundary · job bridge · logging · diagnostics  │
│            │                                                 │
│  Core      ── ProjectScanner · MigrationPlanner ·            │
│               BackupEngine · RestoreEngine · PathRemapper ·  │
│               SecretClassifier · IntegrityVerifier · Jobs    │
│         ┌──────┴────────┐          ┌──────────────────────┐  │
│         │ Providers     │          │ Archive (.devbackup) │  │
│         │ claude-code   │          │ manifest · payload   │  │
│         │ git           │          │ checksums · AES-GCM  │  │
│         │ project-files │          │ Argon2id · hardening │  │
│         │ runtime       │          └──────────────────────┘  │
│         └───────────────┘                                    │
└──────────────────────────────────────────────────────────────┘
                     macOS / Disk (read on backup, written on restore only through ScopedFs)
```

## Workspace layout

| Path                     | Package                 | Responsibility                                                                                                                                                                              |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/model`         | `@devmig/model`         | Isomorphic zod schemas + types for the whole domain (projects, artifacts, manifest, jobs, restore plans, errors). **No Node imports.**                                                      |
| `packages/shared`        | `@devmig/shared`        | Node utilities: path canonicalization, `ScopedFs` (allow-listed writes), `Exec` (args-array only), secret redaction, structured logger, `MigrationError`.                                   |
| `packages/archive`       | `@devmig/archive`       | The `.devbackup` container: streaming tar payload, chunked AES-256-GCM, Argon2id KDF, checksums, hardened extraction.                                                                       |
| `packages/core`          | `@devmig/core`          | Provider contract + registry, job engine, scanner, planner, backup/restore engines, path remapper, secret classifier, integrity verifier. Electron-independent and fully testable headless. |
| `packages/providers/*`   | `@devmig/provider-*`    | One package per provider: `claude-code`, `git`, `project-files`, `runtime`.                                                                                                                 |
| `packages/ipc-contracts` | `@devmig/ipc-contracts` | Whitelisted IPC channels with request/response schemas and the `DevMigrationApi` type.                                                                                                      |
| `packages/test-utils`    | `@devmig/test-utils`    | Fixture builders (temp git repos with worktrees and local changes, fake Claude config dirs).                                                                                                |
| `apps/desktop`           | `@devmig/desktop`       | Electron app: `src/main`, `src/preload`, `src/renderer` (React).                                                                                                                            |
| `fixtures/`              | —                       | Sanitized, committed fixtures. Raw/unsanitized local fixtures are git-ignored.                                                                                                              |
| `tests/e2e`              | —                       | Playwright Electron E2E.                                                                                                                                                                    |
| `docs/`                  | —                       | Architecture, ADRs, research, security (threat model), backup format spec, provider docs.                                                                                                   |

Packages are consumed from TypeScript source (`exports: ./src/index.ts`); electron-vite bundles them into the app,
Vitest runs them directly, `tsc -b` type-checks via project references.

## Key flows

### Create Backup

`DISCOVERING → SCANNING → PLANNING → SECURITY_REVIEW → COLLECTING → PACKING → ENCRYPTING → VERIFYING → COMPLETE`

1. User picks project directories with the native macOS dialog (main process).
2. `ProjectScanner` canonicalizes paths into `ProjectDescriptor`s and runs every provider's `scanProject` (and `scanGlobal`).
3. The renderer shows exactly what was detected; the user picks artifacts. Sensitive artifacts are excluded by default; credentials are never selectable for silent migration.
4. `BackupEngine` creates a private staging dir, calls `createBackupArtifacts` per provider through a `ScopedFs` bound to that provider's staging subdirectory, writes `manifest.json`, `machine.json`, `checksums.json`, then streams the staging tree through tar → chunked AES-256-GCM into the `.devbackup`, and finally re-reads the file to verify every chunk and checksum.

### Restore Backup

`INSPECT → DECRYPT → VALIDATE → MAP_PATHS → PREFLIGHT → STAGE → RESTORE_REPOSITORIES → RESTORE_WORKTREE_STATE → RESTORE_CLAUDE → RESTORE_PROJECT_FILES → VERIFY → REPORT`

No destination is written before the user approves a `RestorePlan`. The plan lists steps, collisions (with non-destructive defaults), preflight checks and the path-remap report. Execution runs providers in a fixed order through a `ScopedFs` whose roots are exactly the approved destinations.

## Non-negotiable rules

1. **Backup never mutates the source.** Providers get read access everywhere but write access only inside their staging dir.
2. **Restore plans before writing** and writes only via `ScopedFs` roots approved in the plan.
3. **No shell strings.** All subprocesses go through `Exec(file, args[])`.
4. **No hard-coded Claude path encoding.** Project ↔ session matching is metadata-driven (`cwd` in transcripts) with the observed encoding treated as a verified hypothesis (see ADR-004).
5. **No global find-and-replace of paths.** Only known, schema-owned path fields are rewritten (ADR-005).
6. **Backups are untrusted input on restore.** Manifest validated with zod, tar entries validated (no `..`, no absolute, no links), size/count limits, checksums, fail closed.
7. **Secrets are classified, never silently migrated.** Credentials (OAuth, session keys) are excluded; sensitive files require explicit opt-in and remain encrypted.
8. **Renderer is untrusted.** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, strict CSP, whitelisted zod-validated IPC, sender validation.

## Testing strategy

- **Unit** (`vitest --project unit`): path utils, redaction, resolver, JSONL parsing, remapping, classifier, manifest validation, crypto round-trips and tamper cases, tar hardening, git parsers.
- **Integration** (`*.integration.test.ts`): temp dirs + real `git`; the Definition-of-Done scenario (fake Mac A → fake Mac B with changed username/path) lives in `packages/core/src/**/migration.integration.test.ts`.
- **E2E** (Playwright + Electron): launches the built app with `DEVMIG_E2E=1`, which swaps native dialogs for a test seam (env-provided paths) — the only test-mode difference.

See the ADRs in `docs/architecture/adr/` for the reasoning behind each decision.
