# ADR-0007: Electron security posture

**Status:** accepted · 2026-08-27

## Decision

- `BrowserWindow.webPreferences`: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`.
- Renderer loads only the bundled `file://` page (dev: the Vite dev server URL); `will-navigate` blocks everything else; `setWindowOpenHandler` denies and forwards `https:` links to the OS browser.
- Strict CSP in `index.html` (`default-src 'self'`; no remote origins).
- Preload exposes `window.devMigration` — a fixed set of methods; no `ipcRenderer`, no generic invoke, no fs/exec.
- Main validates every request with the zod schema from `@devmig/ipc-contracts`, checks the sender frame (main frame of our window, expected origin), and returns errors as values (`IpcEnvelope`).
- Native dialogs (`dialog.showOpenDialog`) run in main; the renderer only receives selected paths.
- Long-running work runs in jobs with `AbortSignal`; CPU-heavy crypto uses streaming and, where needed, worker threads.
- Release builds flip the Electron fuses declared in `apps/desktop/electron-builder.yml`. electron-builder applies
  them after packaging and before signing, so the signature covers the flipped bits. Verify a packaged app with
  `npx @electron/fuses read --app "apps/desktop/release/mac-arm64/Dev Migration Assistant.app"`.

  | Fuse                                    | Expected | Why                                                                                      |
  | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
  | `runAsNode`                             | `false`  | `ELECTRON_RUN_AS_NODE` cannot turn the app into a Node interpreter                       |
  | `enableNodeOptionsEnvironmentVariable`  | `false`  | `NODE_OPTIONS` cannot inject a `--require` preload                                       |
  | `enableNodeCliInspectArguments`         | `false`  | `--inspect` cannot attach a debugger to a shipped build                                  |
  | `enableEmbeddedAsarIntegrityValidation` | `true`   | the asar header hash is checked before any app code runs                                 |
  | `onlyLoadAppFromAsar`                   | `true`   | only the hash-validated `app.asar` is ever loaded                                        |
  | `enableCookieEncryption`                | `true`   | the cookie store on disk is encrypted with the OS keychain                               |
  | `loadBrowserProcessSpecificV8Snapshot`  | `false`  | no separate browser-process snapshot is shipped                                          |
  | `grantFileProtocolExtraPrivileges`      | `true`   | required while the renderer is served from `file://` (flip once a custom scheme is used) |
  | `resetAdHocDarwinSignature`             | `true`   | re-applies the ad-hoc signature after flipping, on Apple Silicon                         |

  The first five are the required set; `apps/desktop/src/main/electron-fuses.test.ts` pins all nine.

## Why

The renderer must be treated as untrusted relative to privileged OS operations. This is the documented Electron baseline (see `docs/research/electron-security.md`).
