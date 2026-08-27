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
- Release builds flip Electron fuses (`RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on).

## Why

The renderer must be treated as untrusted relative to privileged OS operations. This is the documented Electron baseline (see `docs/research/electron-security.md`).
