# Provider: `project-files`

Package: `@devmig/provider-project-files` · display name **Project files** · `supportsGlobal: false` ·
payload `schemaVersion: 1`.

Carries the small local files Git does not: environment files, tool-version pins, package-manager config,
compose overrides and local certificates — for the project and every linked worktree Git reports for it.

## What is captured

Looked up at the root of the project (worktree index `0`) and of every other worktree in
`project.git.worktrees` (index `1..n`; worktrees that are themselves selected projects are skipped so
nothing is captured twice):

| Candidate                                                                                                           | Category          | Typical classification             |
| ------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------- |
| `.env`, `.env.*` (not `.env.example`, `.env.sample`, `.env.template`, `.env.dist`)                                  | `env`             | sensitive → off by default         |
| `.envrc`                                                                                                            | `direnv`          | sensitive → off by default         |
| `.npmrc`, `.yarnrc`, `.yarnrc.yml`                                                                                  | `package-manager` | sensitive (may hold auth tokens)   |
| `.nvmrc`, `.node-version`, `.tool-versions`, `.python-version`, `.ruby-version`, `.java-version`, `.sdkmanrc`       | `version-pin`     | safe → on by default               |
| `docker-compose.override.yml` / `.yaml`                                                                             | `compose`         | sensitive → off by default         |
| `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx` at the root and under `certs/` or `.certs/` (two directory levels deep) | `certificate`     | `.crt` safe; keys credential-class |

Symbolic links are never followed (skipped with a warning). Files above 16 MiB are listed but not selectable.
`.vscode/settings.json` and `.idea/` are **not** included in v0.1 (future work).

### Git decides what is ours

In a Git repository the provider runs `git check-ignore -z --stdin` (paths on stdin, never argv; `cwd` =
the worktree root) and includes **only ignored files**. Tracked and untracked-but-not-ignored files are
shown as non-selectable info rows with the reason _Captured by Git working tree state_ — the Git provider
restores them. When `git check-ignore` is unavailable, every candidate is listed and a warning explains why.
Outside a repository every candidate is listed.

### Classification

Every file goes through the core secret classifier (`classifyFile`: file-name rules + bounded content sniff).

- `safe` → `includedByDefault: true`
- `sensitive` → `includedByDefault: false`, reasons shown (e.g. _Environment file_, _API key (sk-…)_)
- credential-class files (private keys, PKCS#12) → stored as **`sensitivity: 'sensitive'`** with
  `meta.classification: 'credential'`, off by default and labelled _Private key material_. Core never migrates
  `credential` artifacts, so this is the only way a local dev key stays restorable on explicit opt-in.

Artifact ids: `project-files:<projectId>:<worktreeIndex>:<relpath>`. `meta` carries the relpath, worktree
index/root, mode, size, category, classification and git status — never file contents.

## Payload layout

```text
projects/<projectId>/project-files/
├── index.json                       # { schemaVersion: 1, createdAt, files: [{ relpath, worktreeIndex, worktreeRoot,
│                                    #   payloadPath, sizeBytes, sha256, sensitivity, mode, category }] }
└── files/<worktreeIndex>/<relpath>  # byte-for-byte copies (sha256 recorded)
```

Each manifest artifact is one file (`kind: 'file'`, `sourcePath` = absolute source path, `meta` = relpath,
worktree root, mode, sha256, category, classification, `indexPath`).

## Restore

- **Destination:** `mapPath(worktreeRoot) + relpath` (prefix-aware, so worktrees follow the project mapping).
  `relpath` is validated as a safe archive path; anything escaping the destination root is rejected
  (`ARCHIVE_ENTRY_REJECTED`).
- **Collisions:** an existing destination file is a `file-exists` collision with
  `allowedPolicies: ['skip', 'backup-then-replace']`, default `skip`. `backup-then-replace` moves the existing
  file to `<path>.devmig-backup-<timestamp>` before writing. No merge semantics.
- **Preflight (non-blocking):** `destination:<worktreeIndex>` — `pass` when the folder exists and is
  writable, `warn` when it does not exist yet (the Git restore creates it; otherwise it is created on
  demand), `fail`/blocking when it exists but is not a folder or is not writable.
- **Remap report:** `affected` counts relocated files; `safeRewriteCount` is always 0 because **file
  contents are never rewritten** (ADR-0005). Files whose contents mention the old worktree path are listed
  under `unsupportedReferences` so the user can review them.
- **Writes:** payload checksum is verified before writing; files are written atomically through `ScopedFs`
  (`writeFileAtomic`) with the original mode for safe files and **0600 for anything sensitive**.
- **Attention:** an informational `manual` item lists restored files that may contain secrets.

## Verify

Per restored file: sha256 of the destination equals the recorded hash (`pass`/`fail`), permissions are 0600
for sensitive files (`warn` otherwise), the `.devmig-backup-*` file exists when one was created. Skipped
files are reported as `warn` with the reason; failed files as `fail`.

## Known limitations

- `.vscode/`, `.idea/` and other editor state are not captured in v0.1.
- Only ignored files are captured in Git repositories; if the Git provider is not part of a restore, its
  tracked/untracked files are not recreated by this provider.
- `ScopedFs` currently refuses to create a destination root that does not exist yet (its nearest existing
  ancestor is above the root). The provider reports such files as failed with a clear message instead of
  throwing; in the normal flow the Git provider has created the folder already.
- Certificates under `certs/` deeper than two levels are ignored.
