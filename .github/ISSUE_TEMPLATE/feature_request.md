---
name: Feature request
about: Propose an improvement to backup, restore, the container format or the app
title: 'feat: '
labels: ['enhancement', 'needs-triage']
assignees: ''
---

<!--
For a new tool/provider (Codex, Cursor, VS Code, Homebrew, …) use the "Provider request" template instead.
Check docs/ROADMAP.md and docs/KNOWN_LIMITATIONS.md first — it may already be planned or deliberately excluded.
-->

## Problem

What are you trying to do that the app does not let you do today?

## Proposed behaviour

Describe what the user would see. Include the phase (scan / security review / plan / restore / report) where it
fits, and what the report should say when it cannot be done.

## Safety considerations

The app has hard rules (no writes outside the plan, secrets classified not silently migrated, backups untrusted on
restore, no shell strings). Does the proposal touch any of them? How would it stay within them?

## Alternatives considered

## Additional context
