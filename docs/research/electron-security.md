# Electron security & packaging research — Dev Migration Assistant

Research notes for hardening the desktop app (`apps/desktop`) and shipping it as a macOS DMG.
Every fact below is cited to the page it was read from (fetched 2026-08-27). Where a claim
was **not** verified against a fetched page it is marked _(unverified)_.

## 0. Version pins and toolchain facts

| Thing                                 | Value                                                                                                                                                                             | Source                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Electron target                       | `44.0.0` (npm `latest` = 44.0.0)                                                                                                                                                  | `npm view electron version`                                                                    |
| Chromium in Electron 44.0.0           | `152.0.7977.54`                                                                                                                                                                   | `DEPS` at https://raw.githubusercontent.com/electron/electron/v44.0.0/DEPS                     |
| Node.js in Electron 44.0.0            | `v24.18.1`                                                                                                                                                                        | same `DEPS` file                                                                               |
| Electron 44 dropped                   | Windows ia32 and Linux armv7l builds (mac unaffected)                                                                                                                             | https://www.electron.build/docs/architecture                                                   |
| electron-vite                         | `latest` = 5.0.0 (`beta` = 6.0.0-beta.1). Requires Node 20.19+/22.12+ and Vite 5+                                                                                                 | `npm view electron-vite dist-tags`; https://electron-vite.org/guide/                           |
| electron-builder                      | `latest` = 26.15.3, `v26` = 26.15.7, `next` = 27.0.0-alpha.7. **The docs site now documents the v27 config shape** (`mac.sign.*`); v26 uses flat `mac.*` keys — see §9            | `npm view electron-builder dist-tags`; https://www.electron.build/docs/migration/whats-new-v27 |
| @electron/fuses                       | 2.1.3                                                                                                                                                                             | `npm view @electron/fuses version`                                                             |
| zod (already used by `@devmig/model`) | 4.4.3                                                                                                                                                                             | `packages/model/package.json`                                                                  |
| Repo                                  | root `package.json` has `"type": "module"`, `engines.node >=22.12.0`, pnpm workspace with `apps/desktop` (`src/main`, `src/preload`, `src/renderer`) and `packages/ipc-contracts` | repo tree                                                                                      |

Electron security-warning switches: warnings print to DevTools only when the binary is named
`Electron` (i.e. in dev); force with `ELECTRON_ENABLE_SECURITY_WARNINGS` /
`ELECTRON_DISABLE_SECURITY_WARNINGS`. (https://www.electronjs.org/docs/latest/tutorial/security)

## 1. Threat model in one paragraph (why this matters for _this_ app)

The renderer displays **attacker-influenced strings**: Claude Code session transcripts, file
names, branch names, commit messages, `.env` keys, repo paths. Any XSS in the renderer must be
unable to reach Node/Electron APIs — hence sandbox + context isolation + CSP + a narrow,
validated IPC surface. On restore, a `.devbackup` archive is untrusted input (path traversal,
symlinks, oversized entries) and must be validated in the main/utility process, never in the
renderer. Local "living off the land" abuse (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`)
is closed with fuses. Anything that spawns a process (git, `open -a Terminal`) must use an
argument array with no shell. Electron's own framing: "Electron is not a web browser … JavaScript
can access the filesystem, user shell, and more" and "Loading, reading or processing any untrusted
content in an unsandboxed process, including the main process, is not advised."
(https://www.electronjs.org/docs/latest/tutorial/security)

## 2. (a) BrowserWindow `webPreferences` posture

All values below are verified against the WebPreferences structure doc
(https://www.electronjs.org/docs/latest/api/structures/web-preferences) and the security tutorial
(https://www.electronjs.org/docs/latest/tutorial/security). Set them **explicitly** even where they
are already the default so a future default change cannot silently weaken the app.

| Key                           | Electron 44 default    | Our value                                                                     | Why / source                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodeIntegration`             | `false`                | `false`                                                                       | Security #2 (default since 5.0). Also: `nodeIntegration: true` _disables the sandbox_ (sandbox doc).                                                                                                                                                                                                                                                                                                       |
| `contextIsolation`            | `true`                 | `true`                                                                        | Security #3 (default since 12). Preload + Electron internals run in an isolated world; `window` seen by preload ≠ page `window` (context-isolation doc).                                                                                                                                                                                                                                                   |
| `sandbox`                     | `true` (since 20)      | `true`                                                                        | Security #4. Sandboxed renderer has no Node environment; preload gets only a polyfilled `require` for `electron`, `events`, `timers`, `url` (+ `Buffer`, `process`, `setImmediate`, `clearImmediate`) (https://www.electronjs.org/docs/latest/tutorial/sandbox). Additionally call `app.enableSandbox()` **before** `ready` to force it for every renderer (sandbox doc, "Enabling the sandbox globally"). |
| `webSecurity`                 | `true`                 | `true`                                                                        | Security #6: `false` disables same-origin policy _and_ sets `allowRunningInsecureContent: true`.                                                                                                                                                                                                                                                                                                           |
| `allowRunningInsecureContent` | `false`                | `false`                                                                       | Security #8 (mixed content).                                                                                                                                                                                                                                                                                                                                                                               |
| `experimentalFeatures`        | `false`                | `false`                                                                       | Security #9.                                                                                                                                                                                                                                                                                                                                                                                               |
| `enableBlinkFeatures`         | unset                  | unset                                                                         | Security #10.                                                                                                                                                                                                                                                                                                                                                                                              |
| `nodeIntegrationInWorker`     | `false`                | `false`                                                                       | WebPreferences doc.                                                                                                                                                                                                                                                                                                                                                                                        |
| `nodeIntegrationInSubFrames`  | `false` (experimental) | `false`                                                                       | WebPreferences doc.                                                                                                                                                                                                                                                                                                                                                                                        |
| `webviewTag`                  | `false`                | `false`                                                                       | WebPreferences doc: a `<webview>` preload runs with node integration; additionally block `will-attach-webview` (§5).                                                                                                                                                                                                                                                                                       |
| `navigateOnDragDrop`          | `false`                | `false`                                                                       | WebPreferences doc. Users will drag `.devbackup` files / folders onto the window — a drop must never navigate the window to `file://`.                                                                                                                                                                                                                                                                     |
| `preload`                     | —                      | absolute path to the bundled CJS preload                                      | Must be an absolute file path (WebPreferences doc). In an ESM main: `fileURLToPath(new URL('../preload/index.cjs', import.meta.url))` (electron-vite ESM guide, https://electron-vite.org/guide/dev#esm-support-in-electron).                                                                                                                                                                              |
| `devTools`                    | `true`                 | `!app.isPackaged` (optionally re-enable via an explicit flag for bug reports) | `devTools: false` only blocks `openDevTools()` (WebPreferences doc).                                                                                                                                                                                                                                                                                                                                       |
| `safeDialogs`                 | `false`                | `true` (optional)                                                             | Browser-style consecutive-dialog protection (WebPreferences doc). Harmless.                                                                                                                                                                                                                                                                                                                                |
| `enableRemoteModule`          | **n/a**                | —                                                                             | Not a key in the Electron 44 WebPreferences structure (the legacy `remote` module lives outside core as `@electron/remote`; do not install it).                                                                                                                                                                                                                                                            |

Reference window factory (ESM main, electron-vite layout):

```ts
// apps/desktop/src/main/window.ts
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  })
  // dev: Vite dev server (electron-vite sets ELECTRON_RENDERER_URL); prod: built file
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  }
  win.once('ready-to-show', () => win.show())
  return win
}
```

`ELECTRON_RENDERER_URL` / `loadFile` pattern is the documented electron-vite HMR pattern
(https://electron-vite.org/guide/hmr-and-hot-reloading). Only a **hash-based router** works in a
packaged app (https://electron-vite.org/guide/troubleshooting).

Also install a deny-by-default permission handler even though we load no remote content
(security #5: "By default, Electron will automatically approve all permission requests"):

```ts
session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
```

(`session.defaultSession` is only available after `app.whenReady()` — security tutorial.)

## 3. (b) Content-Security-Policy for the Vite-built renderer

Facts:

- Electron honours the CSP **HTTP header** (set via `session.defaultSession.webRequest.onHeadersReceived`)
  but a page loaded over `file://` gets no headers, so use a `<meta http-equiv="Content-Security-Policy">`
  tag for the packaged renderer (security #7, "CSP meta tag"). The official IPC tutorial uses exactly
  `default-src 'self'; script-src 'self'` in a `loadFile()`-loaded page, so `'self'` matches the
  `file://` document (https://www.electronjs.org/docs/latest/tutorial/ipc).
- Vite inlines small assets as `data:` URIs at build time, so `img-src`/`font-src` need `data:`
  (or set `build.assetsInlineLimit: 0`). **Never** allow `data:` in `script-src`
  (https://vite.dev/guide/features#content-security-policy-csp).
- Vite supports `html.cspNonce`: it adds a `nonce` attribute to emitted `<script>`, `<style>`,
  stylesheet `<link>` and modulepreload tags and injects `<meta property="csp-nonce">` — but the
  placeholder must be replaced with a per-load unique value, which is awkward for a static
  `file://` page; prefer `'self'` + hashes for prod (same Vite page).
- Dev server realities _(from Vite behaviour, not a fetched page)_: `@vitejs/plugin-react` injects
  an inline React-Refresh preamble `<script type="module">`, CSS HMR injects `<style>` elements,
  and the HMR client opens a WebSocket to the dev server — so **dev** needs `script-src 'unsafe-inline'`
  (or a nonce), `style-src 'unsafe-inline'`, and `connect-src ws://<host>:<port> http://<host>:<port>`.
  Vite does not require `'unsafe-eval'`.

Recommended policies (React SPA, no network access at all):

```text
# PROD (injected into out/renderer/index.html at build time)
default-src 'none';
script-src 'self';
style-src 'self';                 # add 'unsafe-inline' ONLY if a UI lib injects <style> tags — verify in DevTools
img-src 'self' data:;
font-src 'self' data:;
connect-src 'self';               # app makes no HTTP calls; keep 'self' (module fetches), never http(s):
worker-src 'self';
base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; frame-ancestors 'none';

# DEV (only while ELECTRON_RENDERER_URL is set)
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self' data:;
connect-src 'self' ws://localhost:5173 http://localhost:5173;   # derive host/port from ELECTRON_RENDERER_URL
object-src 'none'; base-uri 'none';
```

Delivery plan:

1. Keep the strict **prod** policy out of `src/renderer/index.html` (the same file is served in dev).
   Inject it with a tiny Vite plugin in `electron.vite.config.ts` (`transformIndexHtml`, `apply: 'build'`)
   so `out/renderer/index.html` carries the `<meta>` tag.
2. In **dev**, the renderer is `http://localhost:<port>` so headers work: in main, when
   `!app.isPackaged && ELECTRON_RENDERER_URL`, register `onHeadersReceived` for that origin and
   append the dev policy (pattern from security #7).
3. Keep both policy strings in one module (`apps/desktop/src/main/csp.ts`) and unit-test that the
   prod string contains no `unsafe-*` tokens.
4. React escapes text by default; never use `dangerouslySetInnerHTML` for transcripts / commit messages;
   if markdown rendering is added, sanitize (CSP `script-src 'self'` is the backstop, not the fix).

Optional later hardening: serve the renderer from a **custom scheme** via `protocol.handle` instead
of `file://` (security #18: `file://` pages "have unilateral access to every file on your machine"),
which also unlocks the CSP header path and lets you flip `grantFileProtocolExtraPrivileges` off (§8).

## 4. (c) IPC hardening

Rules, each traceable to the docs:

1. **Request/response only via `ipcRenderer.invoke` ↔ `ipcMain.handle`** (IPC tutorial, pattern 2;
   `sendSync` is discouraged for blocking the renderer). Main→renderer pushes use
   `webContents.send` wrapped in preload as `onX(cb)` (pattern 3).
2. **Validate the sender of every message** (security #17): use `event.senderFrame`, which is
   `WebFrameMain | null` — _null if the frame navigated or was destroyed_
   (https://www.electronjs.org/docs/latest/api/structures/ipc-main-invoke-event). Parse with `new URL()`;
   "a `startsWith('https://example.com')` test would let `https://example.com.attacker.com` through"
   (security #13). Also allow-list `event.sender.id` against the `webContents.id` of windows we created
   and reject sub-frames.
3. **Never expose `ipcRenderer`, `ipcRenderer.send`, `ipcRenderer.on` or the event object** to the
   page (security #20, context-isolation "Security considerations", context-bridge "Exposing
   ipcRenderer": sending the whole module yields an empty object and "can let any code send any
   message"). Passing the raw callback to `ipcRenderer.on` leaks `event.sender` → wrap it:
   `ipcRenderer.on(ch, (_e, value) => cb(value))` (security #20 example). Consequently do **not** expose
   `@electron-toolkit/preload`'s generic `electronAPI.ipcRenderer` object; electron-vite itself notes
   "the safest way is to use a helper function to wrap the ipcRenderer call rather than expose the
   ipcRenderer module directly" (https://electron-vite.org/guide/dev#toolkit).
4. **Bridge type limits** (https://www.electronjs.org/docs/latest/api/context-bridge): functions are
   proxied; all other values are _copied and frozen_; Symbols dropped; class prototypes dropped;
   thrown `Error`s lose custom properties. `ipcMain.handle` errors reach the renderer with only
   `message` (https://www.electronjs.org/docs/latest/api/ipc-main). ⇒ pass plain JSON and return a
   typed `Result` instead of throwing.
5. **Sandboxed preload constraints**: single-file CJS bundle; only `electron` (contextBridge,
   ipcRenderer, webFrame, webUtils, nativeImage, crashReporter), `events`, `timers`, `url` are
   requirable (sandbox doc). ESM preloads require an _unsandboxed_ renderer and `.mjs`
   (https://www.electronjs.org/docs/latest/tutorial/esm; electron-vite ESM guide). ⇒ in
   `electron.vite.config.ts` force `preload.build.rollupOptions.output.format: 'cjs'` and fully bundle
   it (`build.externalizeDeps: false` for preload; electron-vite "Limitations of Sandboxing",
   https://electron-vite.org/guide/dev#limitations-of-sandboxing and
   https://electron-vite.org/guide/dependency-handling#fully-bundling).

Contract-first channel definitions (fits the existing `packages/ipc-contracts` + zod in `@devmig/model`):

```ts
// packages/ipc-contracts/src/channels.ts  (isomorphic: no Node imports)
import { z } from 'zod'
export const AbsPath = z
  .string()
  .min(1)
  .refine((p) => p.startsWith('/'), 'absolute path required')

export const channels = {
  'devmig:dialog.pickRepos': {
    input: z.object({ defaultPath: AbsPath.optional() }),
    output: z.object({ canceled: z.boolean(), paths: z.array(AbsPath) }),
  },
  'devmig:dialog.pickBackup': {
    input: z.object({}),
    output: z.object({ canceled: z.boolean(), path: AbsPath.nullable() }),
  },
  'devmig:backup.start': { input: BackupRequest, output: z.object({ jobId: JobId }) },
  'devmig:shell.revealInFinder': { input: z.object({ path: AbsPath }), output: z.void() },
  'devmig:shell.openTerminal': { input: z.object({ dir: AbsPath }), output: z.void() },
  'devmig:shell.openExternal': { input: z.object({ url: z.string().url() }), output: z.void() },
} as const
export type Channel = keyof typeof channels
export const events = {
  // main -> renderer pushes
  'devmig:job.progress': JobProgress,
} as const
```

```ts
// apps/desktop/src/main/ipc/register.ts
import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { channels, type Channel } from '@devmig/ipc-contracts'

const trustedWebContents = new Set<number>() // add mainWindow.webContents.id on creation
const rendererDevOrigin = process.env.ELECTRON_RENDERER_URL
  ? new URL(process.env.ELECTRON_RENDERER_URL).origin
  : null
const rendererFileUrl = new URL('../renderer/index.html', import.meta.url).href // file:///.../out/renderer/index.html

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame) return false // navigated/destroyed
  if (!trustedWebContents.has(event.sender.id)) return false // not a window we created
  if (frame !== event.sender.mainFrame) return false // no iframes
  const url = new URL(frame.url)
  if (url.protocol === 'file:')
    return (
      url.origin + url.pathname ===
      new URL(rendererFileUrl).origin + new URL(rendererFileUrl).pathname
    ) // ignore #hash-router state
  if (rendererDevOrigin && url.origin === rendererDevOrigin) return true
  return false
}

export function handle<C extends Channel>(
  channel: C,
  impl: (
    input: z.infer<(typeof channels)[C]['input']>,
    ctx: { win: BrowserWindow | null },
  ) => Promise<z.infer<(typeof channels)[C]['output']>>,
) {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    if (!isTrustedSender(event)) return { ok: false, error: { code: 'E_UNTRUSTED_SENDER' } }
    const parsed = channels[channel].input.safeParse(raw)
    if (!parsed.success)
      return { ok: false, error: { code: 'E_BAD_INPUT', issues: parsed.error.issues } }
    try {
      return {
        ok: true,
        value: await impl(parsed.data, { win: BrowserWindow.fromWebContents(event.sender) }),
      }
    } catch (e) {
      return { ok: false, error: toPublicError(e) }
    } // never leak stack/paths of other users
  })
}
```

```ts
// apps/desktop/src/preload/index.ts  (bundled to index.cjs, runs sandboxed)
import { contextBridge, ipcRenderer, webUtils } from 'electron'
const invoke =
  <C extends Channel>(channel: C) =>
  (input: Input<C>): Promise<Result<Output<C>>> =>
    ipcRenderer.invoke(channel, input)
const subscribe =
  <E extends keyof typeof events>(channel: E) =>
  (cb: (payload: EventPayload<E>) => void) => {
    const listener = (_e: unknown, payload: EventPayload<E>) => cb(payload) // never hand `event` to the page
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
contextBridge.exposeInMainWorld('devmig', {
  pickRepos: invoke('devmig:dialog.pickRepos'),
  pickBackup: invoke('devmig:dialog.pickBackup'),
  startBackup: invoke('devmig:backup.start'),
  revealInFinder: invoke('devmig:shell.revealInFinder'),
  openTerminal: invoke('devmig:shell.openTerminal'),
  openExternal: invoke('devmig:shell.openExternal'),
  onJobProgress: subscribe('devmig:job.progress'),
  pathForDroppedFile: (file: File) => webUtils.getPathForFile(file), // drag-and-drop of .devbackup
} satisfies DevmigApi)
```

Type the bridge for the renderer with a global `Window` augmentation (`interface.d.ts`) as in the
context-isolation tutorial (https://www.electronjs.org/docs/latest/tutorial/context-isolation#usage-with-typescript).
`webUtils` is one of the modules available to sandboxed preloads (sandbox doc); use it to obtain a
filesystem path from a dropped `File` (`File.path` was removed in Electron 32 — _unverified here_).

## 5. (d) Navigation lockdown

- `will-navigate` "Emitted when a user or the page wants to start navigation on the main frame … will
  **not** emit when the navigation is started programmatically with APIs like `webContents.loadURL`"
  and not for in-page/hash navigations; `event.preventDefault()` cancels
  (https://www.electronjs.org/docs/latest/api/web-contents#event-will-navigate). ⇒ denying **all**
  `will-navigate` is safe for us: `loadURL/loadFile` from main still work and a hash router still works.
- `will-frame-navigate` covers sub-frames too; `will-redirect` fires on server-side redirects
  (same page). Deny both.
- `setWindowOpenHandler` is "called before creating a window when a new window is requested by the
  renderer, e.g. by `window.open()`, a link with `target="_blank"`, shift+clicking on a link, or
  submitting a form with `<form target="_blank">`"; return `{ action: 'deny' }`. Returning anything
  unrecognised also denies (https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler).
- Register these on **every** `webContents` from `app.on('web-contents-created')` (security #13/#14).
- Block `will-attach-webview` outright (security #12) — we set `webviewTag: false` but belt-and-braces.
- External links: never route `window.open`/`target=_blank` to `shell.openExternal` automatically;
  the UI calls `devmig.openExternal(url)` and the main handler allow-lists exact `https:` origins
  (security #15: "Do not use `shell.openExternal` with untrusted content").

```ts
// apps/desktop/src/main/security.ts
import { app, shell } from 'electron'
const EXTERNAL_ALLOW = new Set(['https://github.com', 'https://docs.anthropic.com'])
export function lockDownWebContents() {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e) => e.preventDefault())
    contents.on('will-frame-navigate', (e) => e.preventDefault())
    contents.on('will-redirect', (e) => e.preventDefault())
    contents.on('will-attach-webview', (e) => e.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}
export async function openExternalChecked(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || !EXTERNAL_ALLOW.has(url.origin))
    throw new Error('E_URL_NOT_ALLOWED')
  await shell.openExternal(url.href)
}
```

No remote content, ever: the only `loadURL` is the localhost dev server guarded by `!app.isPackaged`.

## 6. (e) Native dialogs

`dialog` is a **main-process** module ("Process: Main",
https://www.electronjs.org/docs/latest/api/dialog); the renderer asks for it over IPC. Pass the
`BrowserWindow` as first argument so the dialog is a modal sheet attached to the window.

`dialog.showOpenDialog([window,] options)` → `Promise<{ canceled, filePaths, bookmarks? }>`;
`filePaths` is `[]` when cancelled. `properties` values: `openFile`, `openDirectory`,
`multiSelections`, `showHiddenFiles` (mac/win), `createDirectory` (mac), `noResolveAliases` (mac),
`treatPackageAsDirectory` (mac), plus `promptToCreate`/`dontAddToRecent` (win). `filters[].extensions`
are listed **without dots or wildcards** (`'devbackup'`, not `'.devbackup'`; `'*'` = all files).
`defaultPath` defaults to Downloads (or home). On Windows/Linux `openFile`+`openDirectory` cannot be
combined (macOS can). `securityScopedBookmarks` is MAS-only — not applicable.

```ts
// choose repositories / worktree roots
const { canceled, filePaths } = await dialog.showOpenDialog(win, {
  title: 'Choose repositories to back up',
  properties: ['openDirectory', 'multiSelections', 'createDirectory'],
  message: 'Select one or more Git repositories', // macOS-only caption
})
// choose an existing backup to restore
const r = await dialog.showOpenDialog(win, {
  title: 'Open a Dev Migration backup',
  properties: ['openFile'],
  filters: [
    { name: 'Dev Migration Backup', extensions: ['devbackup'] },
    { name: 'All Files', extensions: ['*'] },
  ],
})
// choose where to write a new backup — showSaveDialog returns { canceled, filePath } ('' when cancelled)
const s = await dialog.showSaveDialog(win, {
  defaultPath: `${hostname}-${date}.devbackup`,
  filters: [{ name: 'Dev Migration Backup', extensions: ['devbackup'] }],
  properties: ['createDirectory', 'showOverwriteConfirmation'],
})
```

Docs note: on macOS "using the asynchronous version is recommended to avoid issues when expanding
and collapsing the dialog" (showSaveDialog section). For destructive confirmations use
`dialog.showMessageBox(win, { type: 'warning', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1, message, detail })`
→ `{ response }` is the clicked button index (dialog doc). Paths returned by dialogs are user
choices, but still canonicalise (`fs.realpath`) and enforce the scoped-fs root rules before use;
never let the renderer pass an arbitrary path that bypasses the dialog for privileged operations.

## 7. (f) CPU-heavy work: `utilityProcess` and `worker_threads`

- `utilityProcess.fork(modulePath, args?, { env, execArgv, cwd, stdio: 'pipe'|'ignore'|'inherit', serviceName, allowLoadingUnsignedLibraries, disclaim })`
  spawns a Node-enabled child using Chromium's Services API; **only after `app` `ready`**; talk via
  `child.postMessage(msg, [MessagePortMain])` / `process.parentPort` in the child; events `spawn`,
  `exit(code)`, `message`, `error`; `child.kill()` sends SIGTERM (https://www.electronjs.org/docs/latest/api/utility-process).
- Why not `child_process.fork`: with the `runAsNode` fuse disabled "child_process.fork in the main
  process will not function as expected … we recommend that you use Utility Processes"
  (https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode). The process-model doc also says
  to "always prefer the UtilityProcess API over Node.js child_process.fork".
- electron-vite: `import forkPath from './worker?modulePath'` builds an isolated bundle for either
  `utilityProcess.fork(forkPath)` or `new Worker(forkPath)`; `?nodeWorker` gives a Worker constructor
  (https://electron-vite.org/guide/dev#multi-threading). In v5 `?modulePath` imports get isolated
  builds by default (https://electron-vite.org/guide/isolated-build).
- Use in this app: archive streaming (tar + compression + SHA-256), scanning dozens of repos (`git status`,
  worktree enumeration), transcript redaction scans. Keep the main process free for UI/IPC. Rule of
  thumb: `worker_threads` for pure CPU inside one process; `utilityProcess` when the job spawns many
  subprocesses (git) or you want crash isolation and a kill switch.
- Progress: worker → `parentPort.postMessage` → main validates with zod → `win.webContents.send('devmig:job.progress', p)`.
  Keep main as the broker rather than handing a `MessagePort` straight to the renderer, so every
  message crosses one validation point.
- Job cancellation: keep the `UtilityProcess` handle keyed by `jobId`; `child.kill()`; `pid` is
  `undefined` until `spawn` and after `exit` (doc).

## 8. (g) Finder, Terminal and external URLs

- `shell.showItemInFolder(fullPath)` — "Show the given file in a file manager. If possible, select the
  file." `shell.openPath(path)` → `Promise<string>` resolving to an error message or `''`.
  `shell.trashItem(path)` moves to Trash (use for deleting old backups instead of `unlink`).
  The `shell` module "will not function in a sandboxed renderer" — call it in main
  (https://www.electronjs.org/docs/latest/api/shell).
- Open Terminal at a directory on macOS — spawn `/usr/bin/open` with an **argument array and no
  shell**. Node: `child_process.execFile()` "does not spawn a shell by default"; `shell` option
  default `false`; "If the `shell` option is enabled, do not pass unsanitized user input to this
  function" (https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).
  Never build a command string / never use `exec()` with a path.

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, realpath } from 'node:fs/promises'
const execFileP = promisify(execFile)
const TERMINALS = { terminal: 'com.apple.Terminal', iterm: 'com.googlecode.iterm2' } as const // iTerm id unverified; Terminal.app id is com.apple.Terminal

export async function openTerminalAt(dir: string, which: keyof typeof TERMINALS = 'terminal') {
  const real = await realpath(dir)
  if (!(await stat(real)).isDirectory()) throw new Error('E_NOT_A_DIRECTORY')
  // `open -b <bundle-id> <dir>` (or `open -a Terminal <dir>`) opens a new Terminal window at <dir>.
  await execFileP('/usr/bin/open', ['-b', TERMINALS[which], real], { timeout: 10_000 })
}
export function revealInFinder(p: string) {
  shell.showItemInFolder(p)
}
```

Use the absolute `/usr/bin/open` path (no `PATH` lookup), pass the directory as a separate argv
element, verify it is a real directory first (otherwise `open` would launch whatever app owns a
file), and keep the executable allow-listed (never let the renderer choose the app). The exact
`open -a Terminal <dir>` behaviour (new window `cd`'d to the path) is macOS convention, _not_ verified
from a fetched page.

## 9. (h) Electron fuses to flip for release

Fuses are "magic bits" in the Electron binary flipped at package time **before** code signing so the
OS signature protects them (https://www.electronjs.org/docs/latest/tutorial/fuses). Security #19
calls out `runAsNode` and `nodeCliInspect` as letting "external scripts run commands … that your
application might have the rights for".

| Fuse (`FuseV1Options.*`)                | electron-builder key                    | Default | Release value                                                         | Notes (fuses tutorial)                                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------- | ------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunAsNode`                             | `runAsNode`                             | on      | **off**                                                               | Disables `ELECTRON_RUN_AS_NODE`; breaks `child_process.fork` → use `utilityProcess` (§7).                                                                                                                        |
| `EnableCookieEncryption`                | `enableCookieEncryption`                | off     | **on**                                                                | One-way transition; on macOS relies on Keychain like `safeStorage`, so the app "should be code signed for it to work correctly". We store no cookies, so it is harmless either way.                              |
| `EnableNodeOptionsEnvironmentVariable`  | `enableNodeOptionsEnvironmentVariable`  | on      | **off**                                                               | Ignores `NODE_OPTIONS` and `NODE_EXTRA_CA_CERTS`.                                                                                                                                                                |
| `EnableNodeCliInspectArguments`         | `enableNodeCliInspectArguments`         | on      | **off**                                                               | Ignores `--inspect*`; `SIGUSR1` no longer opens the inspector.                                                                                                                                                   |
| `EnableEmbeddedAsarIntegrityValidation` | `enableEmbeddedAsarIntegrityValidation` | off     | **on**                                                                | Validates `app.asar` hash at load (macOS ≥16, Windows ≥30). Requires asar packaging and, in electron-builder, `asar.disableIntegrity` not set (https://www.electron.build/docs/tutorials/adding-electron-fuses). |
| `OnlyLoadAppFromAsar`                   | `onlyLoadAppFromAsar`                   | off     | **on**                                                                | Only `app.asar` is searched (not `app/`, not `default_app.asar`); with the integrity fuse "impossible to load non-validated code".                                                                               |
| `LoadBrowserProcessSpecificV8Snapshot`  | `loadBrowserProcessSpecificV8Snapshot`  | off     | off                                                                   | Only for custom V8 snapshots.                                                                                                                                                                                    |
| `GrantFileProtocolExtraPrivileges`      | `grantFileProtocolExtraPrivileges`      | on      | on for now → **off** once the renderer is served from a custom scheme | Extra `file://` powers: `fetch` to `file://`, service workers, universal child-frame access. "If you aren't serving pages from `file://`, you should disable this fuse."                                         |
| `WasmTrapHandlers`                      | `wasmTrapHandlers`                      | on      | on                                                                    | Performance feature; leave.                                                                                                                                                                                      |

How to flip with electron-builder (https://www.electron.build/docs/tutorials/adding-electron-fuses):
top-level `electronFuses: { runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, loadBrowserProcessSpecificV8Snapshot: false, grantFileProtocolExtraPrivileges: true }`.
"electron-builder flips fuses after packaging and **before** signing … On Apple Silicon, the ad-hoc
signature is re-applied automatically after flipping fuses." Alternative: an `afterPack` hook calling
`context.packager.addElectronFuses(context, { version: FuseVersion.V1, strictlyRequireAllFuses: true, ... })`
so a future Electron major that adds a fuse fails the build instead of silently shipping a default
(`strictlyRequireAllFuses`, https://github.com/electron/fuses). Verify a built app with
`npx @electron/fuses read --app "dist/mac-arm64/Dev Migration Assistant.app"`.

Dev caveat: `electron-vite dev` runs the stock `node_modules/electron` binary with default fuses, so
fuse-dependent behaviour (e.g. `child_process.fork` failing) only shows up in packaged builds — hence
prefer `utilityProcess` everywhere so dev and prod behave the same.

## 10. (i) electron-builder macOS packaging

### Targets and architecture

- `dmg` is "the standard distribution format for direct-download macOS apps"; default mac targets
  are `zip` + `dmg` (both needed only for Squirrel.Mac auto-update) (https://www.electron.build/mac,
  https://www.electron.build/dmg). We ship **`dmg` only**, `arch: ['arm64']` (`--mac --arm64`).
  Add `x64` or `universal` later if Intel users appear; universal is "~2x file size" and merges the
  two ASARs with `lipo` (https://www.electron.build/docs/architecture). No native modules ⇒ nothing
  arch-specific to configure.
- DMG defaults: format `UDZO`, `filesystem` defaults to **APFS in v27** (HFS+ in v26; APFS cannot mount
  on macOS < 10.13) — set it explicitly (https://www.electron.build/dmg).
- `appId` reverse-DNS, set explicitly; "Changing it after first release will break existing user data
  paths" (mac page). Category `public.app-category.developer-tools`.
- v27 validates `productName`/`executableName` (no sanitisation needed) — "Dev Migration Assistant" is fine.

### Unsigned local build

- "To skip signing, leave all `CSC_*` environment variables unset and set
  `CSC_IDENTITY_AUTO_DISCOVERY=false`, or set `mac.sign.identity` to `null`" (v27 key; v26: `mac.identity: null`,
  CLI `-c.mac.identity=null`) (https://www.electron.build/docs/features/code-signing/code-signing-mac).
  electron-builder "does **not** apply an ad-hoc signature automatically" when no cert is found.
- "If you disable code signing, you should also disable Hardened Runtime (`hardenedRuntime: false`), as
  the combination of no signing and enabled Hardened Runtime may prevent the app from launching" (mac page).
- Wanting a runnable local build without a certificate: ad-hoc identity `"-"` **plus** the
  `com.apple.security.cs.disable-library-validation` entitlement (preferred, keeps hardened runtime),
  because Electron's prebuilt frameworks carry Apple's Team ID (code-signing-mac page). Unsigned apps
  can still be run locally by approving them in System Settings → Privacy & Security (same page).
- Script: `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist:mac -- --config electron-builder.local.yml`
  where the local config sets `hardenedRuntime: false` and no `notarize`.

### Signed + notarized release

- Requirements: Apple Developer Program, **Developer ID Application** certificate, Hardened Runtime,
  entitlements, credentials (https://www.electron.build/docs/features/code-signing/notarization).
  "On macOS 10.15+, notarization is additionally required for apps distributed outside the Mac App Store"
  (https://www.electron.build/docs/features/code-signing/). Gatekeeper only accepts Apple-issued certs.
- Pipeline (all automatic in electron-builder): pack → `afterPack` (fuses) → codesign with hardened
  runtime + entitlements → `afterSign` → notarize via `@electron/notarize` (upload, poll) → **staple**
  ticket (automatic with `notarize: true`) → DMG.
- `mac.notarize: true` activates only if env creds are present; options, in order of preference:
  (1) `APPLE_API_KEY` (base64 `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (+ `APPLE_TEAM_ID`);
  (2) `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; (3) `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`
  (mac page `notarize` property; notarization page).
- Certificate in CI: `CSC_LINK` (base64 `.p12` or path) + `CSC_KEY_PASSWORD`; `CSC_NAME` to pick an
  identity; set `forceCodeSigning: true` in CI so a missing cert fails the build instead of "silently
  unsigned production builds" (code-signing page).
- Hardened runtime: `hardenedRuntime` defaults to `true` for darwin builds and is required for
  notarization (mac page). Minimum entitlements Electron needs (notarization page):
  `com.apple.security.cs.allow-jit` (V8 JIT) and `com.apple.security.cs.allow-unsigned-executable-memory`.
  Do **not** ship `com.apple.security.cs.allow-dyld-environment-variables` (mac page comment: "REMOVE for production").
  App Sandbox (`com.apple.security.app-sandbox`) is MAS-only — we deliberately do not adopt it because the
  app must read `~/.claude`, arbitrary repos and `.env` files.
- Verification: `spctl --assess --verbose --type exec "<app>"` → `accepted, source=Notarized Developer ID`;
  `xcrun stapler validate "<app>"`; `codesign --verify --deep --strict --verbose=2 "<app>"` (notarization page).
- macOS privacy (TCC) _(Apple keys, not from fetched pages — verify)_: reading Desktop/Documents/Downloads
  and external volumes triggers per-folder prompts; add usage strings via `mac.extendInfo`
  (`NSDesktopFolderUsageDescription`, `NSDocumentsFolderUsageDescription`, `NSDownloadsFolderUsageDescription`,
  `NSRemovableVolumesUsageDescription`, `NSNetworkVolumesUsageDescription`). Full Disk Access cannot be
  requested programmatically; document it for users whose repos live in protected locations.

### Config (v26 shape, with v27 equivalents)

```yaml
# apps/desktop/electron-builder.yml  (electron-builder 26.x)
appId: com.cxbilen.devmig
productName: Dev Migration Assistant
artifactName: ${productName}-${version}-${arch}.${ext}
directories: { output: dist, buildResources: build }
files: ['out/**/*', 'package.json'] # electron-vite output only; bundle all @devmig/* into out/
asar: true
npmRebuild: false # no native modules
electronFuses: # see §9
  runAsNode: false
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
  loadBrowserProcessSpecificV8Snapshot: false
  grantFileProtocolExtraPrivileges: true # flip to false after moving to a custom scheme
mac:
  category: public.app-category.developer-tools
  target: [{ target: dmg, arch: [arm64] }]
  darkModeSupport: true
  hardenedRuntime: true # v27: mac.sign.hardenedRuntime
  entitlements: build/entitlements.mac.plist # v27: mac.sign.entitlements
  entitlementsInherit: build/entitlements.mac.inherit.plist # v27: mac.sign.entitlementsInherit
  notarize: true # stays on mac.notarize in v27
  extendInfo:
    NSDesktopFolderUsageDescription: 'Dev Migration Assistant backs up repositories you select.'
    NSDocumentsFolderUsageDescription: 'Dev Migration Assistant backs up repositories you select.'
    NSDownloadsFolderUsageDescription: 'Dev Migration Assistant reads and writes .devbackup files you choose.'
dmg:
  filesystem: APFS
  format: UDZO
  contents:
    - { x: 130, y: 220, type: file }
    - { x: 410, y: 220, type: link, path: /Applications }
```

v26 → v27 renames (`identity`, `entitlements`, `entitlementsInherit`, `hardenedRuntime`, `signIgnore`→`ignore`,
`type`, `binaries`, `requirements`, `timestamp` …) all move under `mac.sign.*`; `mergeASARs`/`singleArchFiles`
move under `mac.universal.*`; run `electron-builder migrate-schema` when upgrading
(https://www.electron.build/docs/migration/v27-breaking-changes). v27 also requires Node ≥ 22.12 and
ships as native ESM (https://www.electron.build/docs/migration/whats-new-v27).

`build/entitlements.mac.plist` (and identical `entitlements.mac.inherit.plist` for helpers):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
```

### electron-vite build shape that packaging depends on

- Output `out/{main,preload,renderer}`; `package.json` `"main": "./out/main/index.mjs"` (ESM because the
  root package is `"type": "module"` and Electron ≥ 28; electron-vite emits `.mjs`) — confirm the emitted
  filenames after the first build (https://electron-vite.org/guide/build, https://electron-vite.org/guide/dev#esm-support-in-electron).
- Main/preload: `electron` + Node built-ins are always external; **`dependencies` are externalised,
  `devDependencies` are bundled** (https://electron-vite.org/guide/dependency-handling). ⇒ keep every
  runtime dep of `apps/desktop` (including `@devmig/*` workspace packages) in `devDependencies` (or
  `build.externalizeDeps.exclude`) so nothing must be resolved from `node_modules` inside the asar; this
  sidesteps the pnpm hoisting problems electron-vite documents ("`Cannot find module`" → `shamefully-hoist`)
  (https://electron-vite.org/guide/troubleshooting). Before electron-vite 5 this was the `externalizeDepsPlugin`.
- Preload: `format: 'cjs'`, `externalizeDeps: false`, single entry (sandbox requirement, §4).
- Test the packaged layout before signing with `electron-vite preview` and `electron-builder --dir`
  (troubleshooting page: "Before packaging — run the preview command").

## 11. (j) Concrete checklist for Dev Migration Assistant

Main process (`apps/desktop/src/main`)

- [ ] `app.enableSandbox()` before `app.whenReady()`; window factory sets every `webPreferences` key from §2 explicitly.
- [ ] `lockDownWebContents()` (§5) registered before any window is created: deny `will-navigate`, `will-frame-navigate`, `will-redirect`, `will-attach-webview`; `setWindowOpenHandler → deny`.
- [ ] `session.defaultSession.setPermissionRequestHandler(() => callback(false))` after ready.
- [ ] Only `loadURL` target is `ELECTRON_RENDERER_URL` behind `!app.isPackaged`; prod uses `loadFile(out/renderer/index.html)`; hash router in the SPA.
- [ ] Dev CSP injected via `onHeadersReceived` for the dev origin; prod CSP `<meta>` injected at build (§3); unit test forbids `unsafe-*`/`http:`/`data:` in `script-src` of the prod policy.
- [ ] All privileged work (dialogs, fs, git, archives, shell) lives in main or a utility process — never in the renderer.
- [ ] `shell.openExternal` only through `openExternalChecked` (https + exact-origin allow-list); `shell.showItemInFolder`/`openPath` only on canonicalised paths inside user-chosen roots.
- [ ] Terminal: `execFile('/usr/bin/open', ['-b', 'com.apple.Terminal', dir])`; directory existence check; no `exec`, no `shell: true` anywhere in the codebase (add an ESLint `no-restricted-imports`/`no-restricted-syntax` rule for `exec`, `execSync`, `shell: true`).
- [ ] Git invocations: `execFile('git', [...])` with argv arrays, `cwd` set to the repo, `env` minimal; treat all output as data.
- [ ] Heavy jobs run in `utilityProcess.fork(modulePath?modulePath)`; `jobId → child` map with `kill()`; progress relayed through main with zod validation (§7).
- [ ] No `child_process.fork` (breaks once `runAsNode` is off).
- [ ] `devTools: !app.isPackaged`; consider a documented opt-in flag for support.
- [ ] Do not register a custom URL scheme (`app.setAsDefaultProtocolClient`) — no need, and it adds an untrusted-input entry point. If `.devbackup` file association is added later, treat the `open-file` path as untrusted.

IPC (`packages/ipc-contracts`, `apps/desktop/src/preload`)

- [ ] Every channel declared once with zod `input`/`output`; `handle()` wrapper parses input, checks `isTrustedSender` (senderFrame non-null, main frame, `webContents.id` allow-list, URL compared with `new URL`), returns `Result` objects, never throws across IPC.
- [ ] Preload exposes only named functions; no `ipcRenderer`, no raw `send/on/invoke`, no event objects; subscriptions return unsubscribe functions.
- [ ] Preload built as a single CJS file with `externalizeDeps: false`; `require('electron')` only.
- [ ] Renderer typed via `Window` augmentation; renderer has zero Node imports (electron-vite refuses `nodeIntegration` anyway).
- [ ] Redaction of secrets happens in main before anything is sent to the renderer or written to logs; renderer never receives raw `.env` values unless the user explicitly reveals them.

Renderer (`apps/desktop/src/renderer`)

- [ ] No `dangerouslySetInnerHTML`; transcripts / commit messages / paths rendered as text; markdown (if any) sanitised.
- [ ] No third-party scripts, fonts or images from the network; assets bundled by Vite.
- [ ] Drag-and-drop uses `webUtils.getPathForFile` via preload; the dropped path still goes through the same IPC validation as a dialog result.

Packaging / release (`apps/desktop/electron-builder.yml`, `build/`, CI)

- [ ] `electronFuses` block from §9; CI step runs `npx @electron/fuses read --app <app>` and fails if any fuse differs from the expected table.
- [ ] `asar: true`, `files: ['out/**/*', 'package.json']`, runtime deps bundled (no `node_modules` needed in the asar).
- [ ] `build/entitlements.mac.plist` + `.inherit.plist` with only `allow-jit` and `allow-unsigned-executable-memory`; no `allow-dyld-environment-variables`; `disable-library-validation` only in the ad-hoc local config.
- [ ] Local unsigned build: `CSC_IDENTITY_AUTO_DISCOVERY=false` + `hardenedRuntime: false` + no notarize (separate config file).
- [ ] Release build on `macos-latest` with `CSC_LINK`/`CSC_KEY_PASSWORD`, `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`/`APPLE_TEAM_ID`, `forceCodeSigning: true`, `notarize: true`; then `spctl --assess`, `stapler validate`, `codesign --verify --deep --strict`.
- [ ] `arch: [arm64]` DMG now; revisit `universal` once there is demand (2x size).
- [ ] Pin `electron-builder` to the 26.x line until 27 is stable; keep config keys ready for `migrate-schema`.

Tests

- [ ] Playwright/E2E: `window.require`, `window.process`, `window.electron` are `undefined`; `window.open()` returns `null`/is denied; setting `location.href` to `https://…` is blocked; `<meta http-equiv="Content-Security-Policy">` present in the packaged `index.html`.
- [ ] Unit: `isTrustedSender` rejects `senderFrame === null`, sub-frames, foreign origins, unknown `webContents.id`; every channel rejects malformed input.
- [ ] Unit: restore path validation rejects `..`, absolute entries and symlink escapes from a `.devbackup`.
- [ ] Dev console shows **no** Electron security warnings.

## 12. Open questions

1. Does a Vite `type="module"` bundle still load from `file://` when `grantFileProtocolExtraPrivileges`
   is **off**? The fuse doc lists only `fetch`, service workers and child-frame access as the removed
   privileges, but module-script loading is CORS-governed. Test in a packaged build before flipping;
   otherwise move to a custom `app://` scheme first (security #18).
2. Confirm emitted filenames from electron-vite 5 with the root `"type": "module"`: main `index.mjs`,
   preload `index.cjs` when `format: 'cjs'` is forced (troubleshooting page says CJS output gets `.cjs`).
3. `mac.notarize` in the 26.x line: docs now describe v27; check whether 26.15.x accepts `notarize: true`
   as boolean or requires the older `{ teamId }` object.
4. `webUtils.getPathForFile` / removal of `File.path` (Electron 32) — verify against the breaking-changes page.
5. Exact TCC usage-description keys and whether `open -b com.apple.Terminal <dir>` is preferred over
   `open -a Terminal <dir>`; iTerm2 bundle id.
6. Minimum macOS for Electron 44 (`LSMinimumSystemVersion` must not be set below it).

## 13. Sources

Electron

- https://www.electronjs.org/docs/latest/tutorial/security (20-point checklist; CSP; sender validation; fuses; openExternal)
- https://www.electronjs.org/docs/latest/tutorial/context-isolation
- https://www.electronjs.org/docs/latest/tutorial/sandbox
- https://www.electronjs.org/docs/latest/tutorial/ipc
- https://www.electronjs.org/docs/latest/tutorial/process-model
- https://www.electronjs.org/docs/latest/tutorial/esm
- https://www.electronjs.org/docs/latest/tutorial/fuses
- https://www.electronjs.org/docs/latest/tutorial/code-signing
- https://www.electronjs.org/docs/latest/api/structures/web-preferences
- https://www.electronjs.org/docs/latest/api/browser-window
- https://www.electronjs.org/docs/latest/api/web-contents (will-navigate, will-frame-navigate, will-redirect, setWindowOpenHandler)
- https://www.electronjs.org/docs/latest/api/context-bridge
- https://www.electronjs.org/docs/latest/api/ipc-main
- https://www.electronjs.org/docs/latest/api/structures/ipc-main-invoke-event
- https://www.electronjs.org/docs/latest/api/dialog
- https://www.electronjs.org/docs/latest/api/shell
- https://www.electronjs.org/docs/latest/api/utility-process
- https://www.electronjs.org/docs/latest/api/session
- https://releases.electronjs.org/release/v44.0.0 ; https://raw.githubusercontent.com/electron/electron/v44.0.0/DEPS
- https://github.com/electron/fuses

electron-vite

- https://electron-vite.org/guide/ ; https://electron-vite.org/guide/dev ; https://electron-vite.org/guide/build
- https://electron-vite.org/guide/dependency-handling ; https://electron-vite.org/guide/isolated-build
- https://electron-vite.org/guide/hmr-and-hot-reloading ; https://electron-vite.org/guide/troubleshooting ; https://electron-vite.org/config/

Vite

- https://vite.dev/guide/features#content-security-policy-csp

electron-builder

- https://www.electron.build/ ; https://www.electron.build/mac ; https://www.electron.build/dmg
- https://www.electron.build/docs/architecture ; https://www.electron.build/docs/cli ; https://www.electron.build/configuration
- https://www.electron.build/docs/features/code-signing/ ; https://www.electron.build/docs/features/code-signing/code-signing-mac
- https://www.electron.build/docs/features/code-signing/notarization ; https://www.electron.build/docs/tutorials/adding-electron-fuses
- https://www.electron.build/docs/migration/whats-new-v27 ; https://www.electron.build/docs/migration/v27-breaking-changes

Node.js

- https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback
