# Renderer (React) — how the UI is built

`apps/desktop/src/renderer` is the only UI code. It never imports from Node or Electron: everything it needs
arrives through `window.devMigration` (the `DevMigrationApi` type in `@devmig/ipc-contracts`) and the zod types in
`@devmig/model`.

## Layout

| Path                   | What lives there                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/index.ts`     | `getApi()` — returns the preload bridge when it is complete, otherwise the mock. `setApiForTests()` injects an implementation.                     |
| `src/api/mock-api.ts`  | In-memory `DevMigrationApi` with a simulated job engine (phases, checklist items, cancellation), a demo backup, collisions and attention items.    |
| `src/api/mock-data.ts` | Deterministic fixtures: projects `looplift` (187 sessions, 2 worktrees, `.env.local`) and `playagain` (94 sessions, weak Claude match).            |
| `src/stores/`          | zustand stores: `backup-wizard`, `restore-wizard`, `jobs` (subscribes via `api.jobs.onProgress/onState`, keeps events per job).                    |
| `src/hooks/`           | `useJob(jobId)` (live snapshot + events + last non-terminal phase), `useAsyncValue/useAsyncAction`, `useDebounced`, `useHomeDir`, prefs.           |
| `src/components/ui/`   | Primitives: Button (cva), Checkbox/Switch/RadioGroup/Tooltip/Dialog (Radix), TextField, PasswordField, Badge, StatusIcon, PathText, ErrorPanel.    |
| `src/components/`      | AppShell (sidebar + titlebar drag regions + step indicator), WizardPage, ArtifactRow, ProviderSection, ProgressChecklist, PhaseStrip, JobEventLog. |
| `src/screens/`         | One file per route (see below).                                                                                                                    |
| `src/lib/`             | Pure helpers: formatting, path display/validation, totals, phases, password strength, error normalization, routes.                                 |
| `src/test/`            | `setup.ts` (jest-dom + polyfills + cleanup) and `helpers.tsx` (`installMockApi`, `renderApp`, fixtures).                                           |

Routing uses `HashRouter` (the packaged app is served from `file://`). Every wizard screen guards its own
prerequisites and redirects backwards when state is missing; the two end screens render an empty state instead.

## Routes

| Route                | Screen           | Notes                                                                                      |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `/`                  | Home             | Resets both wizards when a wizard is started.                                              |
| `/backup/projects`   | Select Projects  | `projects.selectDirectories` → `projects.scan`                                             |
| `/backup/scan`       | Project Scan     | Phase strip + per-project checklist from `item` events; auto-continues on completion.      |
| `/backup/review`     | Backup Review    | Provider sections, artifact checkboxes, totals; weak Claude matches badged.                |
| `/backup/security`   | Security Review  | Included / Sensitive (opt-in) / Excluded / Credentials, password, label, output path.      |
| `/backup/progress`   | Backup Progress  | COLLECTING → PACKING → ENCRYPTING → VERIFYING; cancel with confirmation.                   |
| `/backup/complete`   | Backup Complete  | Stats, Show in Finder, Done.                                                               |
| `/restore`           | Open backup      | `backups.selectFile` → `readHeader` → password → `inspect`.                                |
| `/restore/contents`  | Contents         | Machine summary, per-project artifacts, global toggle.                                     |
| `/restore/mapping`   | Locations        | Debounced `restore.previewRemap` + `system.pathExists`; `restore.plan` on Continue.        |
| `/restore/preflight` | Plan review      | Preflight checks, collisions (policies limited to `allowedPolicies`), remap report, steps. |
| `/restore/progress`  | Restore Progress | Phase checklist + per-project items; cancel explains partial state.                        |
| `/restore/report`    | Migration Report | Provider outcomes, verification, attention list, Open in Terminal / Show in Finder.        |
| `/settings`          | Settings         | Ephemeral-state toggle persisted in `localStorage` (`devmig.showEphemeral`).               |
| `/diagnostics`       | Diagnostics      | Diagnostics, logs, copy report, verify a backup file, GitHub link.                         |

## Working without the bridge

`electron-vite dev` runs against the mock automatically (the current preload only exposes `meta`). The demo
backup offered by `backups.selectFile()` unlocks with `demo-password`; the second pick returns an unsupported
(v99) file and the third simulates a cancelled dialog. Backups created in the same session can be restored.

## Tests

`pnpm vitest run --project renderer` — jsdom + Testing Library. Each test imports `../test/setup` (jest-dom
matchers, `ResizeObserver` stub, automatic cleanup) because the root config has no `setupFiles`; the file is ready
to be referenced from `vitest.config.ts` once that is wired. `installMockApi()` gives every test a fast mock
(`timeScale: 0`) so jobs complete in the next event-loop turn.
