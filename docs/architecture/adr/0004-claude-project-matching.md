# ADR-0004: Metadata-driven Claude Code project matching

**Status:** accepted · 2026-08-27

## Decision

`ClaudeProjectResolver` associates `~/.claude/projects/<dir>` entries with selected projects using evidence, not a hard-coded transformation:

1. Resolve the Claude config dir (`$CLAUDE_CONFIG_DIR` or `~/.claude`).
2. Enumerate candidate project directories.
3. Sample the first N JSONL records of each transcript and extract `cwd` values (the canonical project evidence; also `gitBranch`, `sessionId`, `version`).
4. Match canonicalized `cwd` against the selected project's real path **and its registered Git worktrees** (including Claude-managed worktrees under `<project>/.claude/worktrees/*` that may no longer exist on disk).
5. Report `confidence: exact | strong | weak` with the evidence list. `exact` = cwd equals the project path; `strong` = cwd is a worktree of the project or the directory name reproduces the observed encoding _and_ at least one cwd agrees; `weak` = name-only match with no cwd evidence → shown for review, never auto-included.

The observed directory-name encoding (every character outside `[A-Za-z0-9]` → `-`) is recorded as a **hypothesis** that is verified per machine against existing directories + cwd evidence. The verification result is stored in the backup's `restoreHints` and re-verified on the destination when Claude Code data exists there. On restore the destination directory name is derived from the verified encoding; if verification is impossible the app still restores but marks the outcome `warn` and explains that Claude Code may need the sessions to be relocated.

## Why

Claude Code's internal encoding is undocumented and has changed before. Sessions carry their own `cwd`, which is authoritative; the directory name is a cache key. Building on evidence keeps the tool working across Claude Code versions and makes ambiguity visible instead of silently wrong.
