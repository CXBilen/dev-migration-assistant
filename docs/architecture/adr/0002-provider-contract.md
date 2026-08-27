# ADR-0002: Provider-owned migration semantics

**Status:** accepted · 2026-08-27

## Decision

All migration behaviour lives behind `MigrationProvider` (`packages/core/src/providers/contract.ts`):
`detect → scanProject/scanGlobal → createBackupArtifacts → planRestore → restore → verify (+ remapPaths)`.
Providers are registered explicitly in a typed `ProviderRegistry`; core orchestration iterates providers and never branches on provider ids.

Providers never receive raw `fs`. Backup gives them a `ScopedFs` bound to their staging subdirectory; restore gives them a `ScopedFs` bound to the destinations approved in the plan. Subprocesses run only through `Exec(file, args[])`.

Each provider declares a `schemaVersion` recorded in the manifest (`providers[id]`), so payload layouts evolve independently of the container format.

## Why

"Claude Code knows how to migrate Claude Code; Git knows how to migrate Git." Keeping semantics with the provider makes future providers (Codex, Cursor, VS Code, Ghostty…) additive and keeps the core free of provider-specific hacks. The `ScopedFs` boundary turns "never write outside the plan" from a convention into an enforced property.
