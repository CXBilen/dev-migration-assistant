# Renderer (React) — how the UI is built

`apps/desktop/src/renderer` is the only UI code. It never imports from Node or Electron: everything it needs
arrives through `window.devMigration` (the `DevMigrationApi` type in `@devmig/ipc-contracts`) and the zod types in
`@devmig/model`.

## Layout

| Path                   | What lives there                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/index.ts`     | `getApi()` — returns the preload bridge when it is complete, otherwise the mock. `setApiForTests()` injects an implementation.                                  |
| `src/api/mock-api.ts`  | In-memory `DevMigrationApi` with a simulated job engine (phases, checklist items, cancellation), a demo backup, collisions and attention items.                 |
| `src/api/mock-data.ts` | Deterministic fixtures: projects `looplift` (187 sessions, 2 worktrees, `.env.local`) and `playagain` (94 sessions, weak Claude match).                         |
| `src/stores/`          | zustand stores: `backup-wizard`, `restore-wizard`, `jobs` (subscribes via `api.jobs.onProgress/onState`, keeps events per job).                                 |
| `src/hooks/`           | `useJob(jobId)` (live snapshot + events + last non-terminal phase), `useAsyncValue/useAsyncAction`, `useDebounced`, `useHomeDir`, prefs.                        |
| `src/components/ui/`   | Primitives: Button (cva), Checkbox/Switch/RadioGroup/Tooltip/Dialog (Radix), TextField, PasswordField, Badge, StatusIcon, PathText, ErrorPanel.                 |
| `src/components/`      | AppShell (sidebar + titlebar drag regions + step indicator), WizardPage, ArtifactRow, ProviderSection, ProgressChecklist, PhaseStrip, JobEventLog, WarningList. |
| `src/screens/`         | One file per route (see below).                                                                                                                                 |
| `src/lib/`             | Pure helpers: formatting, path display/validation, totals, phases, password strength, error normalization, routes.                                              |
| `src/test/`            | `setup.ts` (jest-dom + polyfills + cleanup) and `helpers.tsx` (`installMockApi`, `renderApp`, fixtures).                                                        |

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

`pnpm vitest run --project renderer` — jsdom + Testing Library. `src/test/setup.ts` (jest-dom matchers,
`ResizeObserver` stub, automatic cleanup) is referenced from the root `vitest.config.ts` and also imported by each
test file so a test can run in isolation. `installMockApi()` gives every test a fast mock (`timeScale: 0`) so jobs
complete in the next event-loop turn.

## Test ids (E2E contract)

Every interactive element and container an E2E test needs carries a stable `data-testid`. Static ids:

`backup-cancel`, `backup-cancel-dialog`, `backup-checklist`, `backup-complete`, `backup-complete-empty`, `backup-continue`, `backup-done`, `backup-file-name`, `backup-log`, `backup-projects-count`, `backup-retry`, `backup-sessions-count`, `backup-show-in-finder`, `backup-size`, `backup-status`, `backup-warnings`, `backup-worktrees-count`, `contents-continue`, `contents-global`, `contents-include-global`, `contents-machine`, `contents-summary`, `contents-tools`, `diag-about`, `diag-app`, `diag-app-version`, `diag-claude`, `diag-claude-dir`, `diag-claude-version`, `diag-copy`, `diag-format-version`, `diag-github`, `diag-logs-dir`, `diag-open-logs`, `diag-providers`, `diag-search-path`, `diag-tools`, `diag-verify`, `diag-verify-dialog`, `diag-verify-log`, `diag-verify-panel`, `diag-verify-password`, `diag-verify-result`, `diag-verify-start`, `home`, `home-create-backup`, `home-diagnostics`, `home-footer`, `home-mock-badge`, `home-restore-backup`, `home-settings`, `mapping-continue`, `mapping-remap-report`, `mapping-summary`, `plan-blocked`, `plan-collisions`, `plan-collisions-none`, `plan-execute`, `plan-global`, `plan-log`, `plan-preflight`, `plan-remap`, `plan-retry`, `plan-status`, `plan-summary`, `plan-unsupported`, `plan-warnings`, `projects-add`, `projects-continue`, `projects-empty`, `projects-list`, `report-attention`, `report-done`, `report-global`, `report-verification`, `report-warnings`, `restore-cancel`, `restore-cancel-dialog`, `restore-checklist`, `restore-complete`, `restore-complete-empty`, `restore-continue`, `restore-empty`, `restore-file-name`, `restore-format-version`, `restore-header`, `restore-header-failed`, `restore-kdf`, `restore-log`, `restore-password`, `restore-password-panel`, `restore-phases`, `restore-retry`, `restore-select-file`, `restore-status`, `restore-unlock`, `restore-unsupported`, `review-continue`, `review-global`, `review-reset-defaults`, `review-select-all`, `review-select-all-dialog`, `review-total-artifacts`, `review-total-sessions`, `review-total-size`, `review-total-worktrees`, `review-totals`, `review-warnings`, `review-weak-notice`, `scan-cancel`, `scan-checklist`, `scan-continue`, `scan-log`, `scan-retry`, `scan-status`, `screen-backup-progress`, `screen-diagnostics`, `screen-projects`, `screen-restore-contents`, `screen-restore-mapping`, `screen-restore-open`, `screen-restore-preflight`, `screen-restore-progress`, `screen-review`, `screen-scan`, `screen-security`, `screen-settings`, `security-checklist`, `security-choose-output`, `security-credentials`, `security-encryption`, `security-excluded`, `security-file`, `security-included`, `security-label`, `security-output-path`, `security-password`, `security-password-confirm`, `security-password-strength`, `security-sensitive`, `security-start`, `security-summary`, `settings-default-folder`, `settings-show-ephemeral`, `sidebar-home`, `sidebar-nav-backup`, `sidebar-nav-diagnostics`, `sidebar-nav-home`, `sidebar-nav-restore`, `sidebar-nav-settings`, `wizard-back`.

Ids derived from data:

| Pattern                                                                                                        | Meaning                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sidebar-step-<n>`                                                                                             | Wizard step in the sidebar (`data-state` = done · current · upcoming, `aria-current="step"`).                                   |
| `projects-item-<index>` / `projects-remove-<index>`                                                            | Selected project row and its remove button.                                                                                     |
| `phase-<PHASE>`                                                                                                | Phase strip entry (`data-status` = pending · running · done · failed · skipped).                                                |
| `checklist-<itemId>`                                                                                           | Progress checklist row (`data-status`); item ids come from `ProgressEvent.item.id`, e.g. `proj_looplift:git-bundle`, `encrypt`. |
| `scan-checklist-<projectId>` / `backup-checklist-<projectId>` / `restore-checklist-<projectId>` (+ `-overall`) | Per-project checklist cards on the progress screens.                                                                            |
| `review-project-<projectId>`                                                                                   | Project card on Backup Review.                                                                                                  |
| `review-<projectId>-<providerId>` / `review-global-<providerId>`                                               | Provider section inside a project card / the Global Claude Code Environment panel.                                              |
| `artifact-<artifactId>` / `artifact-checkbox-<artifactId>` / `needs-review-<artifactId>`                       | Artifact row, its checkbox (`data-state` = checked · unchecked) and the weak-match badge.                                       |
| `security-item-<artifactId>`                                                                                   | Read-only line in the Included / Excluded / Credentials groups.                                                                 |
| `security-sensitive-item-<artifactId>` / `security-sensitive-<artifactId>`                                     | Sensitive artifact row and its opt-in switch (`aria-checked`).                                                                  |
| `contents-project-<projectId>` / `contents-project-toggle-<projectId>`                                         | Project panel on Restore Contents and its select-all checkbox.                                                                  |
| `restore-artifact-<artifactId>` / `restore-artifact-checkbox-<artifactId>`                                     | Artifact line and checkbox on Restore Contents.                                                                                 |
| `mapping-project-<index>` / `mapping-input-<index>` / `mapping-choose-<index>`                                 | Project panel, editable destination input and native chooser on Restore Mapping.                                                |
| `mapping-status-<index>` / `mapping-exact-<index>` / `mapping-remap-<index>` / `mapping-exists-<index>`        | Live status block: exact path match · sessions require remapping · non-empty destination warning.                               |
| `preflight-check-<checkId>`                                                                                    | Preflight row (`data-status` = pass · warn · fail).                                                                             |
| `collision-<collisionId>` / `collision-<collisionId>-policy` / `collision-<collisionId>-<policy>`              | Collision card, its radio group and one radio per allowed policy (`aria-checked`).                                              |
| `plan-project-<projectId>` / `plan-step-<stepId>`                                                              | Steps panel per project and one row per restore step.                                                                           |
| `report-project-<projectId>` / `report-open-terminal-<index>` / `report-show-in-finder-<index>`                | Project panel on the Migration Report and its actions.                                                                          |
| `report-outcome-<projectId or global>-<providerId>`                                                            | Provider outcome section (`data-status` = ok · partial · failed · skipped).                                                     |
| `report-attention-<itemId>` / `report-check-<checkId>`                                                         | Attention item and verification check (`data-status`).                                                                          |
| `diag-provider-<providerId>`                                                                                   | Provider status row on Diagnostics.                                                                                             |
| `diag-tool-<toolId>`                                                                                           | Developer tool row on Diagnostics.                                                                                              |
| `error-panel-hint` (or `<testId>-hint`)                                                                        | Hint paragraph inside an ErrorPanel.                                                                                            |

Status glyphs (`StatusIcon`) expose their meaning as `role="img"` + `aria-label` (OK, Warning, Error, Info, Excluded, Pending, In progress), so tests can assert semantics without reading colours.
