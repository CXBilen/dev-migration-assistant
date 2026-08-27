# ADR-0006: Git portable state and worktree reconstruction

**Status:** accepted · 2026-08-27

## Decision

- Repository objects/refs travel as a **git bundle** (`git bundle create <file> --all` plus `HEAD`) so restore does not depend on network access.
- Per worktree, the local delta is captured separately: staged diff (`git diff --cached --binary --full-index`), unstaged diff (`git diff --binary --full-index`), untracked files (`git ls-files --others --exclude-standard -z`, copied as files), and explicitly selected ignored files.
- Worktrees are captured **logically** (`path`, `branch`, `head`, `relativeToPrimary`) — `.git/worktrees` metadata is never copied.
- Restore: `git clone --no-hardlinks <bundle> <dest>` → restore remotes from metadata → checkout branch/HEAD → `git worktree add <newPath> <branch>` per worktree → apply staged diff with `git apply --index --binary`, unstaged diff with `git apply --binary`, copy untracked files → verify with `git worktree list --porcelain` and `git status --porcelain=v2` against the captured expectation.
- Branch names, remote URLs and paths are validated (`git check-ref-format`, no leading `-`) and always passed as argv elements.

## Why

Git-native mechanisms are exact, compact and offline. Copying `.git/worktrees` between machines carries stale absolute paths; reconstructing from logical state is deterministic and verifiable.
