# ADR-0001: Monorepo and technology stack

**Status:** accepted · 2026-08-27

## Decision

pnpm workspace monorepo; TypeScript 5.9 strict; Electron 44 (Node 24 runtime) via electron-vite 5 / Vite 7; React 19 + Tailwind 4 + Radix primitives in the renderer; zod 4 for every boundary; zustand for wizard state; Vitest 4 (unit/integration) and Playwright (Electron E2E); ESLint 10 flat config + Prettier; electron-builder for the macOS DMG.

Packages are consumed from source (`exports: ./src/index.ts`) and bundled by electron-vite; `tsc -b` with project references provides type-checking.

## Why

- electron-vite is the maintained, Electron-aware Vite integration; its peer range is Vite ^5–^7 so Vite 8 is deliberately not used.
- typescript-eslint supports TS < 6.1, so TypeScript 5.9 is pinned rather than 7.x.
- Consuming packages from source avoids a build step per package and keeps the domain code Electron-independent and directly testable.
- `node-linker=hoisted` in `.npmrc` keeps electron-builder's asar packaging predictable with pnpm.

## Consequences

- Native modules are avoided (Argon2id via `hash-wasm` WASM) so no `electron-rebuild` step exists.
- Adding a package = add folder + `workspace:*` dependency + tsconfig reference.
