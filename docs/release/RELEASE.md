# Release process

## 1. Three things are versioned independently

| What                             | Where                                                            | Bump when                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Application version**          | `package.json` and `apps/desktop/package.json` (`version`), SemVer | Every release. Also recorded in the backup header and manifest (`appVersion`) for diagnostics.              |
| **Container `formatVersion`**    | `DEVBACKUP_FORMAT_VERSION` in `packages/model/src/manifest.ts`; header `formatVersion` | Only when the byte layout, header schema, KDF/cipher construction or manifest schema changes incompatibly. Readers must keep accepting every previous version they can; unknown versions fail with `ARCHIVE_UNSUPPORTED_VERSION`. |
| **Provider `schemaVersion`**     | `schemaVersion` on each `MigrationProvider`; manifest `providers[id]` | When that provider's payload layout changes incompatibly. Providers should read older payloads when feasible and otherwise report a blocking preflight check. |

Rules of thumb:

- A new provider, a new artifact kind, or a new optional manifest field does **not** bump `formatVersion` — zod
  schemas tolerate additive fields.
- Changing the meaning of an existing manifest field, the tar entry order, or the crypto construction does.
- App versions before `1.0.0` may bump the minor for breaking UI/CLI changes; the container format must remain
  readable across `0.x` releases once `0.1.0` ships.

## 2. CHANGELOG discipline

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

- Every user-visible change lands with its PR under **`[Unreleased]`** in one of `Added`, `Changed`, `Deprecated`,
  `Removed`, `Fixed`, `Security`.
- Container or provider schema bumps get an explicit line ("`formatVersion` 1 → 2: …", "claude-code
  `schemaVersion` 1 → 2: …") plus a note on backward compatibility.
- Security fixes reference the advisory (GHSA id) once published.

### Version bump procedure

1. Ensure `main` is green (`pnpm verify` and `pnpm verify:e2e` on CI).
2. Move the `[Unreleased]` entries under a new `## [X.Y.Z] - YYYY-MM-DD` heading; keep an empty `[Unreleased]`.
3. Bump `version` in `package.json` and `apps/desktop/package.json` to `X.Y.Z` (both must match; the preload's
   `meta.appVersion` and the manifest read the desktop package version).
4. Commit: `chore(release): vX.Y.Z`.
5. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin main vX.Y.Z`.
6. The tag push triggers [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## 3. Release workflow

`release.yml` runs on `push` of a `v*` tag (and manually via `workflow_dispatch`) on a macOS Apple Silicon runner:

1. `pnpm install --frozen-lockfile`, a check that `package.json`, `apps/desktop/package.json` and the tag agree on
   the version, then `pnpm verify` (typecheck, lint, format check, unit + integration tests, build) as a last gate.
2. **Unsigned DMG by default.** With `CSC_IDENTITY_AUTO_DISCOVERY=false` and no `CSC_*` variables, `pnpm dist:mac`
   produces `apps/desktop/release/Dev Migration Assistant-<version>-arm64.dmg`. No Apple credentials are required —
   this is the path every fork and every contributor can run.
3. **Signing and notarization are conditional.** A detection step inspects the repository secrets and only when
   they exist does the workflow build a signed (and, with notarization credentials, notarized) DMG:
   - certificate: `CSC_LINK` (base64-encoded Developer ID Application `.p12`) and `CSC_KEY_PASSWORD`;
   - notarization, either `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, **or**
     `APPLE_API_KEY` (base64-encoded App Store Connect `.p8`, decoded to a temp file for the build) +
     `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`. electron-builder reads these from the environment.
   - The checked-in `electron-builder.yml` keeps `notarize: false` so local builds never try. The signed step writes
     a CI-only `electron-builder.ci-signed.yml` that `extends` the base config, sets `mac.notarize` and
     `forceCodeSigning: true` (a missing certificate fails the build instead of producing a silently unsigned
     "signed" release), and is deleted afterwards together with the decoded key.
   - After a signed build the workflow runs `codesign --verify --deep --strict`, `spctl --assess --type exec` and,
     when notarization ran, `xcrun stapler validate`; any failure fails the job.
   - Secrets are **never required for contributor PRs**; `ci.yml` uses no secrets at all.
4. `SHA256SUMS.txt` is generated next to the DMG.
5. The DMG and checksums are uploaded as a workflow artifact and, for tag builds, attached to a **draft GitHub
   release** (`softprops/action-gh-release`) with auto-generated notes and a note stating whether the build is
   signed/notarized. A maintainer reviews the notes, pastes the `CHANGELOG.md` section, and publishes.

Fuses (`RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off,
`OnlyLoadAppFromAsar` on — ADR-0007) are flipped by electron-builder after packaging and before signing **once the
`electronFuses` block is declared in `apps/desktop/electron-builder.yml`** (pending; see the security gate in
[`docs/security/THREAT_MODEL.md`](../security/THREAT_MODEL.md) §5). Verify a release build with
`npx @electron/fuses read --app "apps/desktop/release/mac-arm64/Dev Migration Assistant.app"`.

Pre-release versions (`0.1.0-alpha.1`, `0.1.0-beta.2`, …) follow the same procedure; the tag is `v0.1.0-alpha.1`
and the draft release should be marked as a pre-release by the maintainer before publishing.

### Local equivalent

```sh
pnpm verify
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist:mac
open apps/desktop/release/
```

For a locally signed build export the same environment variables as CI before `pnpm dist:mac`.

## 4. Release checklist

- [ ] `CHANGELOG.md` section for the version is complete and mentions any `formatVersion`/`schemaVersion` bump.
- [ ] `version` matches in `package.json` and `apps/desktop/package.json`.
- [ ] `pnpm verify` and `pnpm verify:e2e` green on CI for the release commit (the E2E job fails while
      `tests/e2e` has no `*.e2e.ts` files — Playwright exits non-zero on "no tests found").
- [ ] Security gate in [`docs/security/THREAT_MODEL.md`](../security/THREAT_MODEL.md) §5 walked through; no
      `<to be validated by the security gate>` placeholders left for shipped behaviour; `electronFuses` declared and
      read back from the packaged app.
- [ ] `docs/KNOWN_LIMITATIONS.md` reflects what actually ships.
- [ ] Manual smoke test on a clean macOS user account: install DMG (unsigned flow from the README), create a backup of
      a fixture project, restore into a different path, `claude --resume` finds the sessions, `git status` matches.
- [ ] Backups created with the previous release still open (format compatibility).
- [ ] Tag pushed, workflow green, draft release reviewed, DMG downloaded and Gatekeeper behaviour confirmed
      (unsigned: right-click → Open works; signed: opens directly).
- [ ] Publish the release; announce.

## 5. Hotfix releases

Branch from the tag (`git checkout -b hotfix/vX.Y.Z+1 vX.Y.Z`), fix, add a `Fixed`/`Security` changelog entry,
bump the patch version, tag from the hotfix branch, then merge the branch back into `main`.
