# Integration notes for the main/preload wiring (from the renderer + provider workstreams)

The renderer (`src/renderer`) is already implemented against `DevMigrationApi` and falls back to a MOCK when
`window.devMigration` is missing or partial. **`getApi()` only trusts the bridge when `projects.scan`,
`backups.create`, `restore.plan`, `jobs.onProgress` and `system.diagnostics` are functions** — expose the full API.

Bridge/handler conventions the renderer relies on:

- `system:suggestBackupName` returns the name **without** the `.devbackup` extension (UI appends it); the same
  value is passed back as `suggestedName` to `backups:selectOutputPath`, which must return a path ending in `.devbackup`.
- `backups:inspect` with a wrong password must fail with code `ARCHIVE_AUTH_FAILED` (rendered inline as
  "That password did not unlock this backup."); unsupported versions with `ARCHIVE_UNSUPPORTED_VERSION`.
- Window: `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 16, y: 18 }`, `vibrancy: 'sidebar'`, transparent
  `backgroundColor` — the sidebar is 220px and semi-transparent; both panes reserve a 52px drag band.
- Progress events: item-bearing `ProgressEvent`s carry `projectId` for per-project checklists with stable item ids
  (`<projectId>:<step>`); job-level items (`pack`, `encrypt`, `verify`) omit `projectId`. Restore progress expects the
  `RestorePhase` ids `RESTORE_REPOSITORIES / RESTORE_WORKTREE_STATE / RESTORE_CLAUDE / RESTORE_PROJECT_FILES / VERIFY`.
- Errors cross the bridge as `IpcEnvelope` values; the preload throws `IpcError` (code, message, hint, details).
- The complete list of `data-testid`s used by E2E is documented in `docs/renderer/RENDERER.md`.
- Providers register in this order: git, project-files, claude-code, runtime
  (`createGitProvider`, `createProjectFilesProvider`, `createClaudeCodeProvider`, `createRuntimeProvider`).
- The E2E dialog seam must be inert unless `DEVMIG_E2E=1`.
