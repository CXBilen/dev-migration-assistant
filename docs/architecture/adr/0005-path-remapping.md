# ADR-0005: Structured path remapping only

**Status:** accepted · 2026-08-27

## Decision

`PathRemapper` computes `oldPath → newPath` mappings (prefix-aware, so worktrees and sub-paths follow the project). Providers own the _field-level_ rewrites:

- **Claude Code transcripts:** rewrite only known structured fields — top-level `cwd`; `toolUseResult.transcriptDir`; file-history metadata (`backup.realParentDir`, `snapshot.trackedFileBackups.*.realParentDir`). Never rewrite `message.content` (prose and tool inputs), even when it contains the old path.
- **`~/.claude.json`:** the `projects` map key is moved to the new path (add-only merge).
- **`history.jsonl`:** the `project` field of filtered entries.
- **Git:** worktree paths are recomputed from logical state (ADR-0006), never string-replaced.
- Unknown schemas: preserve, warn, and list under `unsupportedReferences`.

## Why

A conversation may legitimately contain `/Users/olduser/project` as text; rewriting prose corrupts history and can even change code snippets. Schema-aware rewriting is deterministic, testable and reportable ("187 sessions require safe path remapping · ✓ safe automatic remap").
