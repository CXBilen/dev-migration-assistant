---
name: Bug report
about: Something did not work as documented
title: 'bug: '
labels: ['bug', 'needs-triage']
assignees: ''
---

<!--
Security problems: do NOT file them here. Follow SECURITY.md (private advisory).
Never paste real transcripts, real .env contents, tokens, or a real .devbackup. Build a minimal fixture instead.
-->

## What happened

A clear description of the behaviour you saw.

## What you expected

## Steps to reproduce

1. Open the app → …
2. …
3. …

If the problem involves a backup, describe the shape of the projects (number of repos, worktrees, roughly how
many Claude sessions) rather than attaching the file.

## Phase and error

- Flow: Create Backup / Restore Backup / Verify / Diagnostics
- Phase shown when it failed (e.g. `PACKING`, `RESTORE_WORKTREE_STATE`):
- Error code (e.g. `GIT_APPLY_FAILED`, `ARCHIVE_AUTH_FAILED`):
- Error message / hint (redact anything that looks like a secret):

## Environment

Paste the output of **Diagnostics → Copy** from the app (it is redacted), or fill in by hand:

- App version:
- macOS version and chip:
- Claude Code version (`claude --version`):
- git version (`git --version`):
- Was Claude Code running during the operation? yes / no

## Source vs destination (for restore issues)

- Username changed? yes / no
- Project path changed? old → new (you may abbreviate the username)
- Collision policies chosen:

## Logs

Diagnostics → **Open logs**, attach the relevant part. Skim it for secrets first.
