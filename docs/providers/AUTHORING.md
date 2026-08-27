# Authoring a provider

"Claude Code knows how to migrate Claude Code; Git knows how to migrate Git." All migration semantics live behind the
`MigrationProvider` contract ([ADR-0002](../architecture/adr/0002-provider-contract.md)). Adding support for a new
tool — Codex CLI, Cursor, VS Code, Ghostty, Homebrew — means adding one package and registering it. Core never
branches on provider ids.

This guide walks through the lifecycle, the boundaries you must respect, the tests you must ship, and ends with a
worked skeleton for a `CodexProvider`.

## 1. Package layout

```text
packages/providers/codex/
├── package.json            # @devmig/provider-codex, exports ./src/index.ts
├── tsconfig.json           # extends ../../../tsconfig.base.json, references model/shared/core/test-utils
└── src/
    ├── index.ts            # export { CodexProvider, createCodexProvider }
    ├── codex-provider.ts   # the MigrationProvider implementation
    ├── scan.ts             # discovery helpers (pure functions where possible)
    ├── remap.ts            # field-level path rewrites for this provider's files
    ├── schema.ts           # zod schemas for every file format you parse (untrusted input!)
    ├── codex-provider.test.ts              # unit tests (parsers, remap, classification)
    └── codex-provider.integration.test.ts  # temp dirs + real files/git, backup → restore round trip
```

Copy `packages/providers/git/package.json` and `tsconfig.json` as templates. Then:

1. Add `"@devmig/provider-codex": "workspace:*"` to `apps/desktop/package.json`.
2. Add `{ "path": "packages/providers/codex" }` to the root `tsconfig.json` references.
3. Run `pnpm install` (workspace links only; no new third-party dependencies without discussion).

Dependencies available to providers: `@devmig/model`, `@devmig/shared`, `@devmig/core` (types + registry), `zod`,
`ignore` (gitignore-style matching), `tar`, `hash-wasm`, and `execa` **only** via `@devmig/shared`'s `Exec`.

## 2. The contract in one picture

```text
detect ──▶ scanProject / scanGlobal ──▶ createBackupArtifacts ──▶ [ .devbackup ] ──▶ planRestore ──▶ restore ──▶ verify
   │              │                              │                                        │              │          │
 tool           ScannedArtifact[]           ManifestArtifact[]                     RestoreStep[]   outcome     checks
 present?       + summary + warnings        + schemaVersion + restoreHints         + collisions    + attention
                                                                                    + preflight
                                                                                    + remap report
                                                       (optional) remapPaths ── dry-run report for the mapping screen
```

Every method receives a context (`packages/core/src/providers/contract.ts`) that carries `homeDir`,
`claudeConfigDir`, `claudeJsonPath`, `env`, `exec`, `logger`, `signal` and `progress`. **Use the context** — never
`os.homedir()`, never `process.env`, never `child_process`. Tests inject temp homes and a stubbed `exec`.

### `detect(ctx)`

Cheap, read-only. Report whether the tool is present (`available`), its version, and diagnostic details. This feeds
the Diagnostics screen and `machine.json`. Return `available: false` rather than throwing when the tool is missing.

### `scanProject(project, ctx)` / `scanGlobal(ctx)`

Read-only discovery. Return a `ProviderScanResult` with:

- `detected` — whether anything relevant exists for this project (or user).
- `artifacts: ScannedArtifact[]` — what the user can select. Each artifact needs a stable `id` (stable within the scan
  session; a `stableId(canonicalPath + kind)` is a good choice), a `scope` (`project` | `user` | `ephemeral`), a
  `kind`, a human `label` ("Codex sessions (42)"), `sizeBytes`/`count` when cheap, and a **`sensitivity`**:
  - `safe` — no secrets expected;
  - `sensitive` — may contain secrets (env blocks, transcripts that echoed a token): `includedByDefault: false`,
    with `reasons` explaining why;
  - `credential` — an authentication credential: `selectable: false`, never migrated.
- `summary` — the lines the UI shows ("✓ 42 sessions", "! 3 sessions reference a missing worktree").
- `warnings` — anything the user should know.
- `meta` — provider-private data you need at backup time (paths, ids). **No secrets** in `meta`; it is logged.

`ScanContext.allProjects` lists every selected project so you can attribute worktree sessions correctly.
`scanGlobal` is only called when `supportsGlobal` is `true`.

### `createBackupArtifacts(input, ctx)`

Produce the payload for the selected artifacts. You get `ctx.stagingDir` (yours alone) and `ctx.fs` — a `ScopedFs`
rooted at that directory. Write only through `ctx.fs`. Use `ctx.payloadPathFor('sessions/abc.jsonl')` to obtain the
payload-relative POSIX path for the manifest. Use `ctx.tempDir` for scratch files (bundles, diffs) that must not end
up in the payload.

Return `ManifestArtifact[]`, your `schemaVersion`, an optional `summary`, optional `restoreHints` (free-form,
no secrets — e.g. an observed directory-name encoding you verified on the source) and `warnings`.

Rules: never mutate the source; stream large files (`fs.createReadStream` → `ctx.fs.writeFileAtomic` is fine for
small files, use `pipeline` for large ones); call `throwIfAborted(ctx.signal)` in loops; report progress with
`ctx.progress(message, fraction?, item?)` and never fake a fraction.

### `planRestore(input, ctx)`

Read-only against the extracted payload (`ctx.payloadRoot`) and the destination. Produce a `ProviderRestorePlan`:

- `steps` — what you will do, with the real `destination` for each.
- `collisions` — every existing destination file/dir/entry, with `allowedPolicies` whose **first element is
  non-destructive** (`skip`, or `merge` only when you implement deterministic merge semantics) and `policy` set to
  the default. Never guess when merge semantics are uncertain; report and let the user choose.
- `preflight` — checks with `blocking: true` when the restore must not proceed (tool running, destination
  unwritable, missing tool version).
- `remap` — `affected` counts, `safeRewriteCount`, `warnings`, `unsupportedReferences` for paths you found but do
  not know how to rewrite.
- `state` — opaque, serialisable data carried into `restore` (resolved destinations, decisions). No secrets.

Use `ctx.mapPath(oldPath)` for every path you resolve; it is prefix-aware (worktrees and sub-paths follow the project).

### `restore(plan, input, ctx)`

Now — and only now — write, through `ctx.fs`, whose roots are exactly the approved destinations. Honour
`ctx.collisionDecisions[collision.id]` (falls back to the plan's default). Write atomically
(`ctx.fs.writeFileAtomic`). Return a `ProviderRestoreResult` with per-item `status`, `warnings`, `attention` items
(`reauth`, `install`, `manual`) and `state` needed by `verify`.

### `verify(input, ctx)`

Independent checks that the restore produced what the plan promised: files exist, counts match, JSON parses, a
`--resume`-style lookup works. Return `pass`/`warn`/`fail` checks. Be honest — `warn` when you cannot verify.

### `remapPaths(mappings, input, ctx)` (optional)

Dry-run analysis used by the Restore Mapping screen before planning. Same rules as the `remap` section of the plan,
without any writes.

## 3. Boundaries you must respect

| Boundary            | Rule                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ScopedFs**        | All writes go through `ctx.fs`. Reads may use `ctx.fs.read*` or `node:fs` read APIs. Attempting to write elsewhere throws `PATH_OUTSIDE_ALLOWED_ROOT` — that is a bug in your provider.       |
| **Exec**            | Subprocesses only via `ctx.exec(file, args[])`. Validate strings before they become arguments; reject anything starting with `-`; use `--` before positional arguments; set `cwd` explicitly. |
| **Untrusted input** | Every file you parse from a backup or a project (JSON, JSONL, TOML, YAML) goes through a zod schema in `schema.ts`. Unknown fields are preserved, not dropped, when you rewrite files.        |
| **Remap rules**     | Rewrite **only known, schema-owned path fields** (ADR-0005). Never regex-replace prose or free text. List every field you rewrite in your provider's docs.                                    |
| **Secrets**         | Classify; never migrate credentials; keep secrets out of `meta`, `summary`, `restoreHints`, `state`, logs and error messages. The logger redacts, but do not rely on it.                      |
| **Errors**          | Throw `MigrationError` with a stable `ErrorCode` (`packages/model/src/errors.ts`). Wrap unexpected errors with `PROVIDER_FAILED` and a `cause`.                                               |
| **Cancellation**    | Check `ctx.signal` in loops; pass it to streams and `exec`.                                                                                                                                   |
| **Idempotence**     | Restore with `skip`/`merge` defaults must be safe to run twice.                                                                                                                               |

## 4. `schemaVersion`

`schemaVersion` describes the **payload layout your provider writes** (directory structure, file formats inside
your staging dir). It is recorded in the manifest (`providers[id]` and each `ManifestProviderSection`). Bump it
when a restore of an older payload would misbehave; keep reading older versions when feasible and report
`ARCHIVE_UNSUPPORTED_VERSION` (blocking preflight) when you cannot. The container's `formatVersion` and the app
version are independent — see [`docs/release/RELEASE.md`](../release/RELEASE.md).

## 5. Registering the provider

Providers are registered explicitly in the Electron main process. Registration order is the scan/backup order:

```ts
// apps/desktop/src/main/providers.ts (or wherever the registry is assembled)
import { ProviderRegistry } from '@devmig/core'
import { createClaudeCodeProvider } from '@devmig/provider-claude-code'
import { createGitProvider } from '@devmig/provider-git'
import { createProjectFilesProvider } from '@devmig/provider-project-files'
import { createRuntimeProvider } from '@devmig/provider-runtime'
import { createCodexProvider } from '@devmig/provider-codex'

export function createRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(createGitProvider()) // repositories first: worktrees must exist before session dirs
    .register(createProjectFilesProvider())
    .register(createClaudeCodeProvider())
    .register(createCodexProvider())
    .register(createRuntimeProvider())
}
```

On restore the engine does not rely on registration order: the built-in providers run in the fixed order
`git → project-files → claude-code → runtime` (`RESTORE_PROVIDER_ORDER` in
`packages/core/src/restore/provider-order.ts`, phases `RESTORE_REPOSITORIES → RESTORE_PROJECT_FILES →
RESTORE_CLAUDE → RESTORE_RUNTIME`), and every other provider runs afterwards in registry order under a phase named
`RESTORE_<ID>` (`RESTORE_CODEX` for the example). Add your id to `RESTORE_PROVIDER_ORDER` only if it must run
before one of the built-ins.

## 6. Tests with `@devmig/test-utils`

`@devmig/test-utils` (`packages/test-utils/src/index.ts`) provides fixture builders — `makeTempRoot` /
`withTempRoot` (private temp roots that refuse to point at the real home), `createFakeHome` (a
`<root>/Users/<user>` home with `.claude` and `Documents/GitHub`), `createGitRepoFixture` (commits, a feature
branch, a remote, staged/unstaged/untracked/binary changes and a sibling worktree), `createClaudeFixture` (a
realistic `~/.claude` with transcripts, memory, `history.jsonl` and `~/.claude.json`), `createSourceMachineFixture`
/ `createDestinationMachineFixture` ("Mac A" and "Mac B"), `createFakeExec` (scripted `Exec`), `captureGitState` /
`compareGitState` and JSONL helpers. Use them; never touch the real home directory. Minimum test set for a
provider:

- **Unit:** parsers reject malformed input (zod), remap rewrites exactly the documented fields and nothing else,
  classification marks secrets `sensitive`/`credential`, argument validation rejects `-`-prefixed strings.
- **Integration (`*.integration.test.ts`):** in a temp home, create realistic tool state → `scan` → `backup` into a
  staging dir → `planRestore` against an empty destination **and** against a colliding destination → `restore` with
  a changed username/path → `verify` passes; assert that the source tree is byte-identical afterwards and that no
  file exists outside the approved roots.
- **Negative:** attempts to write outside `ctx.fs` throw `PATH_OUTSIDE_ALLOWED_ROOT`; cancellation mid-backup leaves
  no partial payload.

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { noopLogger, realExec } from '@devmig/shared'

let home: string
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'devmig-codex-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function baseCtx(signal = new AbortController().signal) {
  return {
    homeDir: home,
    claudeConfigDir: path.join(home, '.claude'),
    claudeJsonPath: path.join(home, '.claude.json'),
    env: { HOME: home },
    exec: realExec,
    logger: noopLogger,
    signal,
    progress: () => {},
  }
}
```

## 7. Documentation

Add `docs/providers/<id>.md` describing: which files/directories the provider captures, their scope and
sensitivity classification, every path field it rewrites on remap, the merge semantics for each collision kind,
the preflight checks, what `verify` asserts, and known limitations. Link it from `README.md`'s provider table and add
a changelog entry.

## 8. Worked skeleton: `CodexProvider`

Codex CLI stores sessions under `~/.codex/sessions/` (JSONL with a `cwd`-style field), user config in
`~/.codex/config.toml`, and authentication in `~/.codex/auth.json`. Verify these against the installed version before
relying on them — treat everything below as a starting point, not a specification.

```ts
// packages/providers/codex/src/codex-provider.ts
import { createReadStream } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { z } from 'zod'
import type {
  BackupContext,
  DetectionContext,
  MigrationProvider,
  ProviderBackupInput,
  ProviderBackupOutput,
  ProviderDetection,
  ProviderRestoreInput,
  ProviderRestorePlan,
  ProviderRestoreResult,
  ProviderVerification,
  ProviderVerifyInput,
  RestoreContext,
  RestorePlanningContext,
  ScanContext,
  VerifyContext,
} from '@devmig/core'
import type {
  ManifestArtifact,
  ProjectDescriptor,
  ProviderScanResult,
  ScannedArtifact,
} from '@devmig/model'
import { MigrationError, isPathWithin, stableId, throwIfAborted, walkFiles } from '@devmig/shared'

export const CODEX_PROVIDER_ID = 'codex'
export const CODEX_SCHEMA_VERSION = 1

/** Every record we read from a Codex session file is untrusted: validate, keep unknown keys. */
const SessionRecord = z.looseObject({
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
})

function codexDir(ctx: { homeDir: string; env: Record<string, string | undefined> }): string {
  const override = ctx.env.CODEX_HOME?.trim()
  return override ? path.resolve(override) : path.join(ctx.homeDir, '.codex')
}

export class CodexProvider implements MigrationProvider {
  readonly id = CODEX_PROVIDER_ID
  readonly displayName = 'Codex CLI'
  readonly version = '0.1.0'
  readonly schemaVersion = CODEX_SCHEMA_VERSION
  readonly supportsGlobal = true

  async detect(ctx: DetectionContext): Promise<ProviderDetection> {
    const result = await ctx.exec('codex', ['--version'], { reject: false, timeoutMs: 5_000 })
    return {
      providerId: this.id,
      available: !result.failed,
      version: result.failed ? undefined : result.stdout.trim(),
      details: { configDir: codexDir(ctx) },
      notes: result.failed ? ['codex CLI not found on PATH'] : [],
    }
  }

  async scanProject(project: ProjectDescriptor, ctx: ScanContext): Promise<ProviderScanResult> {
    const sessionsDir = path.join(codexDir(ctx), 'sessions')
    const sessions: string[] = []
    for await (const entry of walkFiles(sessionsDir, { signal: ctx.signal, maxEntries: 100_000 })) {
      if (!entry.relativePath.endsWith('.jsonl')) continue
      const cwd = await readFirstCwd(entry.absolutePath) // sample the first N records, validate with SessionRecord
      if (cwd && isPathWithin(project.realPath, cwd)) sessions.push(entry.absolutePath)
    }
    const artifacts: ScannedArtifact[] = []
    if (sessions.length > 0) {
      artifacts.push({
        id: stableId(`${this.id}:sessions:${project.realPath}`),
        providerId: this.id,
        projectId: project.id,
        scope: 'project',
        kind: 'file-set',
        label: `Codex sessions (${sessions.length})`,
        sourcePath: sessionsDir,
        count: sessions.length,
        sensitivity: 'sensitive', // transcripts may echo secrets
        includedByDefault: true,
        selectable: true,
        reasons: ['Transcripts can contain pasted secrets; they stay encrypted in the backup.'],
        meta: { files: sessions },
      })
    }
    return {
      providerId: this.id,
      projectId: project.id,
      detected: artifacts.length > 0,
      artifacts,
      summary: [{ label: `${sessions.length} sessions`, status: sessions.length ? 'ok' : 'info' }],
      warnings: [],
      estimatedBytes: 0,
    }
  }

  async scanGlobal(ctx: ScanContext): Promise<ProviderScanResult> {
    const dir = codexDir(ctx)
    const artifacts: ScannedArtifact[] = [
      {
        id: stableId(`${this.id}:config`),
        providerId: this.id,
        scope: 'user',
        kind: 'file',
        label: 'Codex config.toml',
        sourcePath: path.join(dir, 'config.toml'),
        sensitivity: 'sensitive', // may contain MCP env blocks
        includedByDefault: false,
        selectable: true,
        reasons: ['May contain MCP server environment variables.'],
        meta: {},
      },
      {
        id: stableId(`${this.id}:auth`),
        providerId: this.id,
        scope: 'user',
        kind: 'file',
        label: 'Codex credentials (auth.json)',
        sourcePath: path.join(dir, 'auth.json'),
        sensitivity: 'credential',
        includedByDefault: false,
        selectable: false, // never migrated — user re-authenticates
        reasons: ['Authentication credential. Run `codex login` on the destination.'],
        meta: {},
      },
    ]
    return {
      providerId: this.id,
      detected: true,
      artifacts,
      summary: [],
      warnings: [],
      estimatedBytes: 0,
    }
  }

  async createBackupArtifacts(
    input: ProviderBackupInput,
    ctx: BackupContext,
  ): Promise<ProviderBackupOutput> {
    const out: ManifestArtifact[] = []
    for (const artifact of input.artifacts) {
      throwIfAborted(ctx.signal)
      if (artifact.sensitivity === 'credential') {
        throw new MigrationError('INVALID_INPUT', 'Credentials are never migrated', {
          details: { id: artifact.id },
        })
      }
      const files = z.array(z.string()).parse(artifact.meta.files ?? [artifact.sourcePath])
      let bytes = 0
      for (const file of files) {
        const rel = path.join('sessions', path.basename(file))
        await ctx.fs.copyFile(file, path.join(ctx.stagingDir, rel)) // write only through ctx.fs
        bytes += (await ctx.fs.stat(file)).size
      }
      out.push({
        id: artifact.id,
        providerId: this.id,
        kind: artifact.kind,
        label: artifact.label,
        payloadPath: ctx.payloadPathFor('sessions'),
        sizeBytes: bytes,
        fileCount: files.length,
        sensitivity: artifact.sensitivity,
        sourcePath: artifact.sourcePath,
        meta: {},
      })
      ctx.progress(`Collected ${artifact.label}`, undefined, {
        id: artifact.id,
        label: artifact.label,
        status: 'done',
      })
    }
    return { artifacts: out, schemaVersion: this.schemaVersion }
  }

  async planRestore(
    input: ProviderRestoreInput,
    ctx: RestorePlanningContext,
  ): Promise<ProviderRestorePlan> {
    const dest = path.join(codexDir(ctx), 'sessions')
    // Collisions: a session file with the same id already exists → allow 'skip' (default) or 'merge' (add-only).
    // Remap: only the `cwd` field of each record is rewritten via ctx.mapPath; message text is never touched.
    return {
      providerId: this.id,
      projectId: input.project?.id,
      steps: [
        {
          id: `${this.id}:sessions`,
          providerId: this.id,
          label: 'Restore Codex sessions',
          destination: dest,
          artifactIds: input.artifacts.map((a) => a.id),
        },
      ],
      collisions: [],
      preflight: [],
      remap: {
        affected: [{ label: 'Codex session records (cwd)', count: 0 }],
        safeRewriteCount: 0,
        warnings: [],
        unsupportedReferences: [],
      },
      warnings: [],
      state: { dest },
    }
  }

  async restore(
    plan: ProviderRestorePlan,
    input: ProviderRestoreInput,
    ctx: RestoreContext,
  ): Promise<ProviderRestoreResult> {
    const dest = z.string().parse(plan.state.dest)
    await ctx.fs.mkdir(dest) // throws PATH_OUTSIDE_ALLOWED_ROOT unless dest lies inside an approved root
    // For each payload file: stream records → validate with SessionRecord → rewrite `cwd` with ctx.mapPath
    // → ctx.fs.writeFileAtomic(path.join(dest, name), rewritten). Prose is never touched (ADR-0005).
    void input
    return {
      providerId: this.id,
      projectId: plan.projectId,
      status: 'ok',
      items: [],
      warnings: [],
      attention: [
        {
          id: `${this.id}:reauth`,
          providerId: this.id,
          level: 'info',
          title: 'Sign in to Codex again',
          action: 'reauth',
        },
      ],
    }
  }

  async verify(input: ProviderVerifyInput, ctx: VerifyContext): Promise<ProviderVerification> {
    void input
    void ctx
    return {
      checks: [
        {
          id: `${this.id}:sessions-present`,
          label: 'Codex sessions restored',
          status: 'pass',
          providerId: this.id,
        },
      ],
    }
  }
}

export function createCodexProvider(): MigrationProvider {
  return new CodexProvider()
}

/** Streams the first records of a JSONL session file and returns the first `cwd`. Never reads the whole file. */
async function readFirstCwd(file: string, maxRecords = 50): Promise<string | undefined> {
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }) })
  let seen = 0
  try {
    for await (const line of rl) {
      if (line.trim() === '') continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue // invalid lines are tolerated on scan; restore copies them verbatim
      }
      const parsed = SessionRecord.safeParse(raw)
      if (parsed.success && parsed.data.cwd) return parsed.data.cwd
      seen += 1
      if (seen >= maxRecords) break
    }
  } finally {
    rl.close()
  }
  return undefined
}
```

Checklist before opening the PR:

- [ ] `pnpm verify` passes; new package referenced from the root `tsconfig.json`.
- [ ] Unit + integration tests as in §6; hostile inputs covered.
- [ ] `docs/providers/codex.md` written; README provider table and `CHANGELOG.md` updated.
- [ ] No `os.homedir()`, `process.env`, `child_process` or raw `fs` writes in the provider.
- [ ] Credentials are `selectable: false`; sensitive artifacts are `includedByDefault: false` with reasons.
