# Git provider (`@devmig/provider-git`)

Provider id `git` · payload `schemaVersion` 1 · project scope only (`supportsGlobal: false`).

Implements [ADR-0006](../architecture/adr/0006-git-portable-state.md): repository objects travel as a
`git bundle`, the local delta of every worktree travels as binary-safe diffs plus untracked files, and
worktrees are reconstructed from logical state (`path`, `branch`, `head`, `relativeToPrimary`) —
`.git/worktrees` metadata is never copied.

## What is captured

| Item                                           | Artifact id (`git:<projectId>:…`)    | Kind       | Default | Sensitivity                 | Notes                                                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------ | ---------- | ------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All branches, tags, remote-tracking refs, HEAD | `bundle`                             | `derived`  | on      | safe                        | `git bundle create <tmp>/repo.bundle --all` from the primary worktree, verified with `git bundle verify`.                                                                                                                 |
| Remotes (fetch/push URLs) and branch upstreams | part of `bundle` (`repository.json`) | –          | –       | safe                        | `git remote -v`, `git config --get-regexp '^branch\..*\.(remote\|merge)$'`.                                                                                                                                               |
| Worktree shape                                 | part of `repository.json`            | –          | –       | safe                        | index, absolute path, branch/HEAD/detached, `relativeToPrimary`, locked/prunable flags. Index 0 is always the primary.                                                                                                    |
| Staged + unstaged changes + untracked files    | `worktree:<n>:state`                 | `file-set` | on      | safe                        | One per worktree (primary and every linked worktree). Untracked files that the classifier marks _sensitive_ are excluded.                                                                                                 |
| Sensitive untracked files                      | `worktree:<n>:untracked-sensitive`   | `file-set` | **off** | sensitive                   | Untracked files whose name or content looks like a secret (`classifyFile` from `@devmig/core`). Listed file by file.                                                                                                      |
| Ignored files/directories (top two levels)     | `worktree:<n>:ignored:<slug>`        | file / dir | **off** | classifier (safe/sensitive) | Sized (directories capped at 20 000 files). Credential-classified entries are shown but never selectable.                                                                                                                 |
| Build/dependency/cache directories, `*.log`    | `worktree:<n>:junk:<slug>`           | ephemeral  | –       | safe                        | `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`, `.cache`, `.turbo`, `.vite`, `.DS_Store`, `__pycache__`, `.pytest_cache`, `target`, `.gradle`, `Pods`, `DerivedData`, … — shown "not sized", not selectable. |

Artifact ids are namespaced with the project id because the scanner requires ids to be unique across a
scan session. Each artifact carries typed `meta` (`kind` discriminator) that the provider validates with
zod at backup and restore time; ids are never parsed.

### Not captured (reported as warnings)

| Item                                                   | Why                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Stash entries                                          | `--all` bundles include `refs/stash` but a stash is machine-local state; apply or export it before migrating.          |
| Submodules                                             | Only the superproject pointer is in the bundle; run `git submodule update --init` after restoring.                     |
| Git LFS objects                                        | Only LFS pointers are in the bundle; run `git lfs fetch --all` from the remote after restoring.                        |
| Hooks, `.git/config`, `.git/info/exclude`              | Not part of the repository data; hooks are deliberately never transported or executed.                                 |
| Untracked symlinks, nested repositories, special files | Skipped and listed in `state.json` (`excludedUntrackedPaths`); the verifier accounts for them.                         |
| Untracked credential files                             | `id_rsa`, `*.pem`, `.netrc`, … are never migrated (not even opt-in).                                                   |
| Prunable / missing worktrees                           | Worktrees whose directory no longer exists are listed in `repository.json` but produce no state and are not recreated. |
| Unresolved merge conflicts                             | Captured as plain modifications (conflict markers travel), but the unmerged index state cannot be reproduced.          |

## Scan summary lines

`✓ repository` · `✓ main @ abc1234` (or `! detached HEAD @ …` / `! no commits yet`) · `✓ 3 worktrees` ·
`! 4 modified files` (or `✓ working tree clean`) · `✓ 7 untracked files` · `! 1 sensitive untracked file
excluded by default` · `○ node_modules, dist excluded` · `! 2 stashes not captured` · `! submodules not captured`.

## Payload layout (`projects/<projectId>/git/`)

```text
repository.json                      remotes, upstreams, HEAD, worktree shape, git version, stash/submodule flags
repo.bundle                          git bundle (absent for repositories without commits)
worktrees/<n>/state.json             sorted `git status --porcelain=v2` lines, path lists, diff sizes, exclusions
worktrees/<n>/staged.diff            git -c core.quotepath=false diff --cached --binary --full-index --no-color --no-ext-diff --no-textconv
worktrees/<n>/unstaged.diff          same without --cached (worktree vs index)
worktrees/<n>/untracked/<path>       untracked files (modes preserved)
worktrees/<n>/untracked-sensitive/…  only when the sensitive artifact was selected
worktrees/<n>/ignored/<slug>         explicitly selected ignored files/directories
```

Diffs are written by git straight to a temp file (`--output=`) and copied into staging, so nothing is
buffered in memory; diffs above 512 MB are still captured but flagged with a warning.

## Commands used

Every invocation goes through the injected `Exec` with an argument array; user-derived strings (branch
names, shas, remote names/URLs, paths) are validated first and never start with `-`. Read-only commands
run with `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`; `GIT_DIR`/`GIT_WORK_TREE`-style variables are
stripped from the environment.

| Phase   | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| detect  | `git --version`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| scan    | `git rev-parse --verify HEAD`, `git symbolic-ref --short HEAD`, `git -c core.quotepath=false status --porcelain=v2 --untracked-files=all --ignored=matching -z`, `git count-objects -v`, `git remote -v`, `git stash list`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| backup  | the scan commands plus `git status --porcelain=v2 --untracked-files=all` (verification lines), `git diff [--cached] --binary --full-index --no-color --no-ext-diff --no-textconv --output=<tmp>`, `git config --get-regexp`, `git bundle create <tmp> --all`, `git bundle verify <tmp>`                                                                                                                                                                                                                                                                                                                                                                      |
| plan    | `git --version`, `git bundle list-heads <bundle>`, `git check-ref-format --branch <name>` (after a local check that already rejects `-…`, `a..b`, `HEAD`, `*.lock`, …)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| restore | all with `-c core.hooksPath=/dev/null`: `git init --quiet`, `git symbolic-ref HEAD refs/heads/<branch>`, `git bundle verify`, `git fetch --quiet --update-head-ok <bundle> +refs/heads/*:refs/heads/* +refs/tags/*:refs/tags/* +refs/remotes/*:refs/remotes/*`, `git fetch <bundle> HEAD` (detached), `git reset --quiet --hard` / `git checkout --quiet --detach <sha>`, `git remote add`, `git remote set-url --push`, `git config branch.<b>.remote/merge`, `git worktree add --quiet [--detach] -- <path> <branch\|sha>`, `git apply --index --binary --whitespace=nowarn -- <staged.diff>`, `git apply --binary --whitespace=nowarn -- <unstaged.diff>` |
| verify  | `git rev-parse --verify HEAD`, `git symbolic-ref --short HEAD`, `git -c core.quotepath=false status --porcelain=v2 --untracked-files=all`, `git worktree list --porcelain`, `git remote -v`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Restore algorithm

1. **Destination** — the repository (primary worktree) is restored at the project's mapped path. When
   the selected directory was itself a linked worktree, the primary is restored at
   `ctx.mapPath(<primary path>)` (core derives that sibling mapping) and the selected worktree at the
   project destination; the plan says so in a warning. A destination that does not exist is created
   (0755) by the provider; an empty directory is fine.
2. **Collision check** — a non-empty destination is a `directory-exists` (or `git-repo-exists`)
   collision with policies `skip` (default) and `backup-then-replace` (the directory is renamed to
   `<dest>.devmig-backup-<timestamp>`). Existing linked-worktree paths are `worktree-path-exists`
   collisions with the same policies. Every aside path the plan may create is listed in the plan state
   (`state.asidePaths`, also available through `backupAsidePathsFrom(state)`) so the engine can add
   them to the approved `ScopedFs` roots when the decision is `backup-then-replace`; without that
   approval the move fails closed with `PATH_OUTSIDE_ALLOWED_ROOT` and a hint to choose `skip`.
3. **Repository** — `mkdir` (0755) through `ScopedFs`, `git init`, point HEAD at the captured branch,
   verify + fetch the bundle (`--update-head-ok` lets the unborn current branch be populated), then
   `reset --hard` (attached) or `checkout --detach <sha>` (detached). Repositories without commits are
   only initialised. Remotes and upstream configuration are re-created from `repository.json`. Remote
   URLs are recorded and restored without embedded credentials (userinfo is stripped from `http(s)`
   URLs, passwords from other schemes; `ssh://git@host` keeps its user).
4. **Worktrees** — for each linked worktree whose state artifact was selected: destination =
   `ctx.mapPath(oldPath)` (core derives sibling/child mappings), `git worktree add` (branch, or
   `--detach <sha>`). A branch that is already checked out elsewhere is skipped with a warning.
5. **Working tree state** — per worktree: `git apply --index` of `staged.diff`, then `git apply` of
   `unstaged.diff`, then copy `untracked/` (and `untracked-sensitive/` when selected) preserving modes.
   If an apply fails the repository stays restored, the outcome is `partial` with a `GIT_APPLY_FAILED`
   item and the diff files are placed in `<worktree>/.devmig-unapplied/`.
6. **Ignored entries** — copied to their original relative path; existing files are never overwritten.

Every mutating git call first passes its `cwd` through `ctx.fs.assertAllowed` (symlink-checked), and
`core.hooksPath=/dev/null` guarantees that neither template hooks nor anything inside the restored
content runs during the restore (covered by an integration test with a template-installed `post-checkout`).

## Preflight checks

| id                      | blocking | Meaning                                                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `git-installed`         | yes      | `git --version` succeeded (`GIT_NOT_INSTALLED` otherwise).                                  |
| `git-version`           | no       | Warns below git 2.20.                                                                       |
| `bundle`                | yes      | Bundle present in the payload and readable (`git bundle list-heads`).                       |
| `bundle-required`       | yes      | Working-tree state was selected without the repository bundle (and the source had commits). |
| `branch:<name>`, `head` | yes      | Branch names / shas in `repository.json` pass local validation and `git check-ref-format`.  |
| `destination`           | yes/no   | Fails when the destination is a file; passes for missing ("will be created") or empty dirs. |
| `worktree-state:<n>`    | yes      | `worktrees/<n>/state.json` parses.                                                          |

Remap report: every recreated linked worktree counts as one safe rewrite; there are no unsupported
references because worktree paths are recomputed, never string-replaced.

## Verification

For the primary checkout and every recreated worktree: HEAD sha equals the captured one, branch (or
detached state) equals, and the **set** of `git status --porcelain=v2 --untracked-files=all` lines equals the
captured set minus untracked files that were deliberately not restored (sensitive files not selected,
credential files, symlinks). Then `git worktree list --porcelain` must list exactly the recreated worktrees
with the expected branches, and `git remote -v` must match. Each check is a `VerificationCheck`
(`worktree:<n>:head|branch|status`, `worktrees`, `remotes`) with the first five differences in `detail`.

## Limitations

- **Stashes, submodules, LFS objects, hooks and `.git/config`** are not migrated (see table above).
- `backup-then-replace` moves the existing directory to a sibling path (`<dest>.devmig-backup-<ts>`),
  which must be inside the `ScopedFs` roots the engine approves (`state.asidePaths` /
  `backupAsidePathsFrom(state)`); when it is not, the provider fails that decision with
  `PATH_OUTSIDE_ALLOWED_ROOT` and a hint to choose `skip` — nothing is written first.
- A linked worktree on a branch that is also checked out in another restored worktree is skipped.
- Working-tree state selected without the bundle cannot be applied (blocking preflight), except for
  repositories without commits.
- Intent-to-add entries (`git add -N`) and unmerged index states are restored as plain files.
- `git status` lines are compared literally; a destination with different `core.autocrlf`/filter
  configuration may report a status mismatch even though the content is identical.
