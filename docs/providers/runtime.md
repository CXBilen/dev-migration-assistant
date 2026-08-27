# Provider: `runtime`

Package: `@devmig/provider-runtime` · display name **Development runtime** · `supportsGlobal: true` ·
payload `schemaVersion: 1`.

Informational provider. It records which development tools the source machine had and what each project
expects, then — on restore — compares that with the destination and tells the user what to install or
re-authenticate. **It never writes to the destination.**

## Scan

### Global (`runtime:machine`)

`collectMachineInfo` (core) probes `node`, `pnpm`, `npm`, `bun`, `git`, `claude`, `gh`, `brew` (`--version`,
10 s timeout each, missing binaries never fail the scan) and `sw_vers`. One artifact, `kind: 'json-fragment'`,
`sensitivity: 'safe'`, on by default. Summary rows: `Node 22.22.3` (ok), `pnpm 11.5.3` (ok), `Git 2.50.1`
(ok), `Claude Code 2.1.247` (ok), `Bun not installed` (info), `macOS 26.6 · arm64` (info).

### Project (`runtime:project:<projectId>`)

Read-only, bounded reads at the project root:

- package manager: `packageManager` in `package.json` (`pnpm@11.5.3`) wins; otherwise the lockfile
  (`pnpm-lock.yaml` → pnpm, `bun.lockb`/`bun.lock` → bun, `yarn.lock` → yarn, `package-lock.json` /
  `npm-shrinkwrap.json` → npm; several lockfiles produce a warning);
- workspace: `pnpm-workspace.yaml` or `workspaces` in `package.json`;
- `engines` from `package.json`; Node pin from `.nvmrc` / `.node-version` (first non-comment line);
- frameworks by dependency name: `next`, `nuxt`, `expo`, `electron`, `@sveltejs/kit`, `svelte`, `vite`,
  `react` (major taken from the spec, shown as `Next.js 15.x`).

Summary rows: `pnpm workspace`, `pnpm 11.5.3` (_package.json packageManager_), `Node 22 (.nvmrc)`,
`engines.node >=22.12.0` (info), `Next.js 15.x`. A project with no `package.json`, lockfile or Node pin
is reported as not detected.

## Payload layout

```text
global/runtime/runtime.json                    # { schemaVersion: 1, capturedAt, machine: MachineInfo }
projects/<projectId>/runtime/project-runtime.json
                                               # { schemaVersion: 1, capturedAt, projectPath, runtime: ProjectRuntimeInfo }
```

Both files are validated with zod on read; an invalid file fails planning with `ARCHIVE_INVALID`.

## Restore

`planRestore` produces one step (`compare:machine` / `compare:project`, no destination), no collisions,
and **informational, non-blocking preflight checks** built from the same comparison the restore performs.

`restore` probes the destination (`collectMachineInfo` plus `gh auth status` when `gh` is installed) and
returns `status: 'ok'` with report items and attention items:

| Situation                                        | Item                                          | Attention (`action`)                    | Remediation (display only)                   |
| ------------------------------------------------ | --------------------------------------------- | --------------------------------------- | -------------------------------------------- |
| Git present                                      | `Git installed` ok                            | —                                       |                                              |
| Git missing                                      | `Git not installed` error                     | `runtime:git-missing` (install)         | `xcode-select --install`                     |
| Node majors equal                                | `Node compatible (22 → 22)` ok                | —                                       |                                              |
| Node majors differ                               | `Node major differs (22 → 20)` warn           | `runtime:node-major` (manual)           | `nvm install 22`                             |
| Source package manager missing (pnpm/npm/bun)    | `pnpm not installed` warn                     | `runtime:pm-missing-pnpm` (install)     | `corepack prepare pnpm@11.5.3 --activate`    |
| Claude Code missing                              | `Claude Code not installed` warn              | `runtime:claude-code-missing` (install) | `brew install --cask claude-code` + docs URL |
| `gh auth status` exits 1 (or cannot be verified) | `GitHub CLI authentication required` warn     | `runtime:gh-auth` (reauth)              | `gh auth login`                              |
| `gh` missing                                     | `GitHub CLI not installed` info               | `runtime:gh-missing` (install, info)    | `brew install gh`                            |
| CPU architecture differs                         | `CPU architecture differs (arm64 → x64)` warn | `runtime:arch` (manual)                 | `<pm> install`                               |

Per project: package manager present/missing (`runtime:<projectId>:pm-missing-<pm>`), Node pin or
`engines.node` major vs the destination Node (`runtime:<projectId>:node-major` / `node-missing`), and one
info row per framework.

### Remediation interface (`src/remediation.ts`)

```ts
interface Remediation {
  id: string // e.g. 'install-claude-code'
  title: string
  detail?: string
  command?: string[] // argv, first element is the executable — display only in v0.1
  url?: string
}
```

Remediations are rendered into `AttentionItem.detail` (`Run: gh auth login · See https://…`) and returned
structured in `ProviderRestoreResult.state.remediations` so a later version can offer to execute them
without a shell. v0.1 executes nothing.

## Verify

Pass-through: one check that the payload file is still readable and valid, plus one check per report item
(`ok`/`info` → pass, `warn` → warn, `error` → fail).

## Known limitations

- Node compatibility is a **major-version** comparison; `engines.node` is only used as a minimum major
  (no full semver-range evaluation).
- `gh auth status` may contact GitHub; it is bounded by a 10 s timeout and reported as _could not verify_
  on failure.
- Only the listed frameworks and package managers are recognised; other ecosystems (Python, Rust, Go) are
  not described in v0.1.
