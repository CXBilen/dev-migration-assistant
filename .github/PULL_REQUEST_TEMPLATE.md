## Summary

<!-- What does this change and why? Link the issue (Fixes #123). -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] New provider (`packages/providers/<id>`)
- [ ] Container format / manifest change (requires `formatVersion` or `schemaVersion` decision — see docs/release/RELEASE.md)
- [ ] Docs / CI only

## Hard rules checklist

<!-- These are enforced by review. Tick honestly; explain any "no" in the summary. -->

- [ ] Tests never touch real user data: temp dirs via `fs.mkdtemp`, `homeDir` / `claudeConfigDir` / `claudeJsonPath` injected, no `os.homedir()` on a write path.
- [ ] Backup never mutates the source; restore writes only through the `ScopedFs` bound to approved destinations.
- [ ] No shell strings: subprocesses use `Exec(file, args[])`, external strings validated, `-`-prefixed arguments rejected.
- [ ] Untrusted input (IPC, manifest, tar entries, JSONL, git output) validated with zod; fail closed.
- [ ] Secrets classified, never silently migrated; nothing secret in logs, `meta`, `summary`, `restoreHints`, `state` or error messages.
- [ ] Every failure is a `MigrationError` with a stable `ErrorCode`; long loops honour `AbortSignal`; large data streams.
- [ ] No `any`; type-only imports; Prettier + ESLint clean.

## Tests

<!-- Behaviour that is not tested is not done. -->

- [ ] Unit tests added/updated
- [ ] Integration tests (`*.integration.test.ts`, real fs + real git in temp dirs) added/updated
- [ ] Hostile inputs covered where relevant (traversal, `-` prefixed names, oversize, malformed JSON)
- [ ] `pnpm verify` passes locally

## Docs

- [ ] `CHANGELOG.md` entry under **Unreleased** (user-visible changes)
- [ ] Docs updated (README provider table, `docs/providers/<id>.md`, `docs/KNOWN_LIMITATIONS.md`, threat model row) where relevant

## Screenshots / output

<!-- For UI changes. Never include real paths with secrets, real transcripts or real backups. -->
