# Contributing to Dev Migration Assistant

Thanks for considering a contribution. This document explains how the repository is organised, how to run the
verification suite, and the rules that every change must respect. Most of the rules exist because this app reads
your real `~/.claude` directory and your real repositories and writes to another machine — mistakes are expensive.

## Before you start

- Read [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) and the ADRs in
  [`docs/architecture/adr/`](docs/architecture/adr/). They are short and they are binding.
- Look for an existing issue. For anything larger than a bug fix, open an issue first so we can agree on the
  approach; provider proposals should use the "Provider request" issue template.
- Security problems: **do not** open an issue. Follow [`SECURITY.md`](SECURITY.md).

## Development setup

Requirements: macOS (the app is macOS-only for now, but the core packages test on any Unix), Node 22 (see `.nvmrc`),
pnpm 11 (`corepack enable` picks the exact version from `package.json`'s `packageManager`), and `git`.

```sh
git clone https://github.com/CXBilen/dev-migration-assistant.git
cd dev-migration-assistant
pnpm install
pnpm dev            # Electron app with hot reload
```

The full verification suite is what CI runs:

```sh
pnpm verify         # typecheck + lint + format:check + test:unit + test:integration + build
pnpm verify:e2e     # build + Playwright Electron E2E
```

Individually: `pnpm typecheck`, `pnpm lint` (`pnpm lint:fix`), `pnpm format` (`pnpm format:check`),
`pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm build`, `pnpm dist:mac` (unsigned DMG).

To type-check, lint and test a single package while iterating:

```sh
npx tsc -p packages/providers/git/tsconfig.json --noEmit
npx eslint packages/providers/git
npx vitest run packages/providers/git --project unit
npx vitest run packages/providers/git --project integration
```

## Repository layout

| Path                     | What lives there                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `packages/model`         | zod schemas and types for the whole domain. No Node imports.                                    |
| `packages/shared`        | Path canonicalisation, `ScopedFs`, `Exec`, secret redaction, logger, `MigrationError`.          |
| `packages/archive`       | The `.devbackup` container (tar + chunked AES-256-GCM + Argon2id).                              |
| `packages/core`          | Provider contract and registry, job engine, scanner, planner, backup/restore engines, remapper. |
| `packages/providers/*`   | One package per provider (`claude-code`, `git`, `project-files`, `runtime`).                    |
| `packages/ipc-contracts` | Whitelisted IPC channels with zod request/response schemas.                                     |
| `packages/test-utils`    | Fixture builders: temp git repos with worktrees/changes, fake Claude config dirs, temp homes.   |
| `apps/desktop`           | Electron main, preload and React renderer.                                                      |
| `tests/e2e`              | Playwright Electron tests. `tests/docs` holds documentation/CI consistency tests.               |
| `docs/`                  | Architecture, ADRs, research, security, backup format, provider docs, user guide.               |

## The hard rules

These are enforced by review and, where possible, by lint rules and tests. A PR that breaks one will not be merged.

1. **Never touch real user data in tests.** Tests use `fs.mkdtemp` under `os.tmpdir()` and inject `homeDir`,
   `claudeConfigDir` and `claudeJsonPath` explicitly. No code path a test can hit may default to `os.homedir()` for
   a write. Never read or modify the developer's real `~/.claude`, `~/.claude.json`, repositories, `~/.ssh` or env
   files from a test.
2. **Backup never mutates the source; restore never writes outside the plan.** Providers receive a `ScopedFs`
   bound to their staging directory (backup) or to the destinations approved in the plan (restore). Do not reach for
   `node:fs` to write in a provider.
3. **No shell strings.** Subprocesses go through the `Exec` abstraction (`exec(file, args[])`). `child_process.exec`
   is forbidden by ESLint. Validate every external string (branch names, remote URLs, paths) before passing it as an
   argument and reject arguments that start with `-`.
4. **No hard-coded Claude Code path encoding.** Project ↔ session matching is evidence-driven (ADR-0004).
5. **No global find-and-replace of paths.** Only schema-owned fields are rewritten (ADR-0005).
6. **Backups are untrusted input on restore.** Validate with zod, reject dangerous tar entries, enforce limits,
   verify checksums, fail closed.
7. **Secrets are classified, never silently migrated.** Credentials are never migrated. Never log a secret; use the
   structured logger (which redacts) and never `console.log` in library code.
8. **Renderer is untrusted.** No Node access, no generic IPC tunnel, every channel declared once in
   `packages/ipc-contracts` with zod schemas, sender validation in main (ADR-0007).

## Code quality expectations

- TypeScript strict with `noUncheckedIndexedAccess`; no `any`; type-only imports (`import type`).
- zod at every untrusted boundary (IPC, manifest, tar entries, JSONL records, git output you parse into structures).
- Every failure is a `MigrationError` with a stable `ErrorCode` from `packages/model/src/errors.ts` (append-only).
- Long loops honour `AbortSignal` (`throwIfAborted`); large data is streamed, never read into memory whole.
- Restored files are written atomically (temp + fsync + rename) via `ScopedFs.writeFileAtomic`.
- Prettier formats everything (`pnpm format`); ESLint must be clean (`pnpm lint`).

## Tests are not optional

Behaviour that is not tested is not done.

- **Unit** (`*.test.ts`, `vitest --project unit`): parsers, path utilities, remapping, classification, crypto
  round-trips and tamper cases, tar hardening.
- **Integration** (`*.integration.test.ts`): real filesystem and real `git` in temp directories. Prefer these over
  mocks whenever the behaviour involves files or git.
- **Renderer** (`apps/desktop/src/renderer/**/*.test.tsx`, jsdom + Testing Library).
- **E2E** (`tests/e2e/*.e2e.ts`, Playwright + Electron): the built app with `DEVMIG_E2E=1`, which swaps native
  dialogs for an environment-driven seam.

Fixtures committed to `fixtures/` must be sanitised. Anything generated from a real machine belongs in
`fixtures/local/` or `*.raw.*`, both git-ignored. Never commit a `.devbackup`.

## Adding a provider

See [`docs/providers/AUTHORING.md`](docs/providers/AUTHORING.md). In short: new package under
`packages/providers/<id>`, implement `MigrationProvider`, register it in `apps/desktop/src/main`, ship unit and
integration tests built on `@devmig/test-utils`, document the artifacts and remap rules.

## Pull requests

- Branch from `main`; keep PRs focused. Fill in the PR template.
- Run `pnpm verify` locally before pushing; CI runs the same commands on macOS plus the E2E suite.
- Add a line to `CHANGELOG.md` under **Unreleased** for user-visible changes (Keep a Changelog format).
- Bump a provider's `schemaVersion` when its payload layout changes incompatibly; bump `DEVBACKUP_FORMAT_VERSION`
  only for container changes (see [`docs/release/RELEASE.md`](docs/release/RELEASE.md)).
- Commits: conventional-style prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`) are appreciated but not enforced.
- By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

## Getting help

Open a discussion or an issue with the "Question" prefix. Please include `Diagnostics → Copy` output from the app
(it is redacted) when reporting behaviour you saw in the UI.
