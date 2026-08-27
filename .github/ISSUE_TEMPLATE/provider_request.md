---
name: Provider request
about: Ask for (or offer to build) support for another tool — Codex CLI, Cursor, VS Code, Ghostty, Homebrew, …
title: 'provider: '
labels: ['provider', 'needs-triage']
assignees: ''
---

<!--
Providers are the easiest place to contribute. Read docs/providers/AUTHORING.md — it has a worked CodexProvider skeleton.
Do not paste real config files that may contain tokens; describe their shape or sanitise them.
-->

## Tool

- Name and version:
- Website / docs for its on-disk storage:
- Are you offering to implement it? yes / no / with guidance

## Where its state lives on macOS

List directories and files with their **scope** and **sensitivity** as the provider contract defines them:

| Path                       | Scope (project / user / ephemeral) | Sensitivity (safe / sensitive / credential) | Notes                            |
| -------------------------- | ---------------------------------- | ------------------------------------------- | -------------------------------- |
| `~/.tool/sessions/*.jsonl` | project                            | sensitive                                   | contains `cwd`; may echo secrets |
| `~/.tool/config.toml`      | user                               | sensitive                                   | MCP env blocks                   |
| `~/.tool/auth.json`        | user                               | credential                                  | never migrated                   |

## Path-bearing fields

Which files contain absolute paths, and which fields exactly? (Only schema-owned fields are rewritten on restore —
ADR-0005.)

## Merge semantics

If the destination already has state for this tool, what can be merged deterministically (e.g. add-only by
session id) and what must be left to the user?

## How to verify a restore

What command or check proves the restore worked (the equivalent of `claude --resume`)?

## Known constraints

Retention sweeps, version-specific formats, files that must not be copied (caches, locks, machine ids).
