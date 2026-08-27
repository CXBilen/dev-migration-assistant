# Integration notes for the core engines (from the provider + renderer workstreams)

These are requests from the finished provider/renderer packages. Apply them in the engines you own.

1. **Restore roots must include provider "aside" paths.** ADR-0008 says `backup-then-replace` moves the original to
   `<path>.devmig-backup-<timestamp>` — a SIBLING of the approved root, which `ScopedFs` rejects. Providers (git,
   project-files, claude-code) put the aside paths they intend to create into their plan `state` under
   `state.asidePaths: string[]` (git also exposes them via `backupAsidePathsFrom(state)` in its package). When
   assembling the `ScopedFs` roots in `RestoreEngine.execute`, add every `asidePaths` entry from every provider plan
   (only when the corresponding collision decision is `backup-then-replace`) to the roots.
2. **Do not downgrade provider merge defaults.** `chooseDefaultPolicy` currently applies
   `RestoreOptions.defaultCollisionPolicy` ('skip') whenever the provider allows 'skip'. Claude sessions and memory
   declare `policy: 'merge'` (add-only, non-destructive) as their default. Prefer the provider's `policy` when it is
   `merge`; apply the engine default only when the provider's default is destructive or absent.
3. **Implicit home-dir mapping.** Add `manifest.machine.homeDir → env.homeDir` as a lowest-priority mapping in the
   path mapper used for restore (after explicit project mappings), so references into the old `~/.claude` (e.g.
   `toolUseResult.transcriptDir`, checkpoint `trackingPath`) follow the new home when nothing more specific matches.
4. **Progress conventions expected by the renderer.** Item-bearing `ProgressEvent`s carry `projectId` and stable item
   ids `<projectId>:<step>`; job-level items (`pack`, `encrypt`, `verify`) omit `projectId`. Restore progress uses the
   `RestorePhase` ids `RESTORE_REPOSITORIES / RESTORE_WORKTREE_STATE / RESTORE_CLAUDE / RESTORE_PROJECT_FILES / VERIFY`.
5. **Artifact ids are already namespaced by providers** (`git:<projectId>:…`, `claude-code:<projectId>:…`,
   `project-files:<projectId>:…`, `runtime:…`); keep the uniqueness check but do not re-prefix ids that already start
   with `<providerId>:`.
6. **Provider order on restore:** git → project-files → claude-code → runtime (git creates the destination directory;
   `ScopedFs` can create not-yet-existing roots since the shared fix, so a provider running first may also create it).
7. **Manifest stats:** providers report `summary.sessionCount` (claude-code) and `summary.worktreeCount` (git, linked
   worktrees only); sum them into `stats.claudeSessionCount` / `stats.worktreeCount`.
8. The archive package is complete: `createDevBackup`, `readDevBackupHeader`, `inspectDevBackup`, `extractDevBackup`,
   `verifyDevBackup`, `computeChecksums`, `writeChecksumsFile` are exported from `@devmig/archive`. `extractDevBackup`
   requires an EMPTY destination (pass a fresh mkdtemp dir) and `createDevBackup` requires `manifest.json` at the
   source root with the same id as `opts.manifest`.
