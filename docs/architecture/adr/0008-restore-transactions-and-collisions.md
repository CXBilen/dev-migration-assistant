# ADR-0008: Restore transactions, collisions and merges

**Status:** accepted · 2026-08-27

## Decision

- Restore never writes before the plan is approved. Extraction goes to a private 0700 staging dir; providers then apply changes to approved destinations only.
- Every existing destination artifact is a **collision** in the plan with a non-destructive default (`skip`). Allowed policies per collision: `skip`, `merge` (only when the provider defines deterministic merge semantics), `backup-then-replace` (original moved to `<path>.devmig-backup-<timestamp>`), `alternate-path`.
- Deterministic merges implemented in v0.1: Claude sessions (add-only by session id; identical files skipped, differing files kept as `<id>.devmig-conflict.jsonl` and reported), `~/.claude.json` project entries (add-only; existing entry kept and reported), `history.jsonl` (append missing entries by `(sessionId, timestamp)`).
- When merge semantics are uncertain the provider reports the conflict and requires a user choice; it never guesses.
- Files are written atomically (temp + fsync + rename); on failure/cancel, temp files are removed and the report states that no source data was modified.

## Why

Restoring onto a machine that already has Claude Code data or an existing checkout is common. Making collisions explicit keeps the tool safe by default without blocking legitimate merges.
