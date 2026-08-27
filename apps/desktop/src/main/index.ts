/**
 * Electron main process entry.
 *
 * Security posture (ADR-0007): sandbox forced for every renderer, navigation locked down for every
 * WebContents, permission requests denied, IPC only through the zod-validated router with sender
 * checks, dialogs and OS integration in main. See docs/research/electron-security.md.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserWindow, app, session } from 'electron'
import type { CoreServices } from '@devmig/core'
import type { Logger } from '@devmig/shared'
import { readE2EConfig } from './e2e'
import { registerAllHandlers } from './ipc/handlers'
import { createRouter } from './ipc/router'
import { createSenderGuard } from './ipc/trusted-sender'
import { installApplicationMenu } from './menu'
import { ApprovedPaths } from './services/approved-paths'
import { createAppCore } from './services/core'
import { createDialogService } from './services/dialogs'
import { createE2EDialogSeam } from './services/e2e-dialog-seam'
import { createJobBridge, type JobBridge } from './services/job-bridge'
import { initLogging } from './services/logging'
import { createSystemService } from './services/system'
import { sweepWorkDir } from './services/work-dir'
import { createMainWindow, installWebContentsLockdown } from './window'

const e2e = readE2EConfig(process.env)
const isE2E = e2e !== null
const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const rendererFile = fileURLToPath(new URL('../renderer/index.html', import.meta.url))
const rendererDevUrl =
  !app.isPackaged && !isE2E && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : null

// --- Process-wide hardening, before `ready` -----------------------------------------------------
app.enableSandbox()
if (e2e?.workDir) {
  // Keep the E2E run out of the real ~/Library.
  app.setPath('userData', path.join(e2e.workDir, 'user-data'))
  app.setPath('sessionData', path.join(e2e.workDir, 'session-data'))
  app.setAppLogsPath(path.join(e2e.workDir, 'logs'))
}

const bootLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, ctx) => console.warn(msg, ctx ?? ''),
  error: (msg, ctx) => console.error(msg, ctx ?? ''),
  child: () => bootLogger,
}
let logger: Logger = bootLogger
installWebContentsLockdown({
  debug: (m, c) => logger.debug(m, c),
  info: (m, c) => logger.info(m, c),
  warn: (m, c) => logger.warn(m, c),
  error: (m, c) => logger.error(m, c),
  child: () => logger,
})

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(bootstrap)
}

interface AppState {
  core: CoreServices
  bridge: JobBridge
  disposeRouter: () => void
  createWindow: () => BrowserWindow
}

let state: AppState | null = null
let quitting = false

async function bootstrap(): Promise<void> {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)

  const logging = initLogging({ logsDirectory: app.getPath('logs'), isPackaged: app.isPackaged })
  logger = logging.logger
  logger.info('Starting Dev Migration Assistant', {
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    e2e: isE2E,
  })

  const workDir = e2e?.workDir ?? path.join(app.getPath('temp'), 'devmig')
  await sweepWorkDir(workDir, {
    logger,
    ...(e2e?.workDir ? { allowedRoots: [path.dirname(e2e.workDir)] } : {}),
  })

  const core = createAppCore({
    logger,
    appVersion: app.getVersion(),
    workDir,
    ...(e2e
      ? {
          overrides: {
            homeDir: e2e.homeDir,
            claudeConfigDir: e2e.claudeConfigDir,
            claudeJsonPath: e2e.claudeJsonPath,
          },
        }
      : {}),
  })

  const approved = new ApprovedPaths(core.env.homeDir)
  const dialogs = createDialogService({
    seam: e2e?.dialogFile ? createE2EDialogSeam(e2e.dialogFile, logger) : null,
  })
  const system = createSystemService({
    env: core.env,
    core,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? null,
    logsDirectory: () => logging.logsDirectory,
    logFile: () => logging.logFile,
    documentsDirectory: () => app.getPath('documents'),
    logger,
  })

  const senderGuard = createSenderGuard({
    devOrigin: rendererDevUrl,
    rendererFileUrl: pathToFileURL(rendererFile).href,
  })
  const router = createRouter({
    isTrustedSender: (event) => senderGuard.isTrustedSender(event),
    logger,
  })
  const channels = registerAllHandlers(router, {
    core,
    dialogs,
    system,
    approved,
    logger,
    ...(e2e?.workDir ? { extraDestinationRoots: [path.dirname(e2e.workDir)] } : {}),
  })
  logger.info('IPC handlers registered', { count: channels.length })

  const bridge = createJobBridge({
    jobs: core.jobs,
    logger,
    broadcast: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && senderGuard.trustedIds().includes(win.webContents.id)) {
          win.webContents.send(channel, payload)
        }
      }
    },
  })

  installApplicationMenu({
    isPackaged: app.isPackaged,
    openExternal: (url) => system.openExternal(url),
  })
  app.setAboutPanelOptions({
    applicationName: 'Dev Migration Assistant',
    applicationVersion: app.getVersion(),
    credits: 'Migration Assistant, but for developers. Local only · Encrypted · Open source.',
  })

  const createWindow = (): BrowserWindow => {
    const win = createMainWindow({
      preloadPath,
      rendererUrl: rendererDevUrl,
      rendererFile,
      isPackaged: app.isPackaged,
      additionalArguments: [
        `--app-version=${app.getVersion()}`,
        ...(isE2E ? ['--devmig-e2e'] : []),
      ],
    })
    senderGuard.trust(win.webContents)
    return win
  }

  state = { core, bridge, disposeRouter: () => router.dispose(), createWindow }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.on('window-all-closed', () => {
  // macOS convention: stay alive until Cmd+Q. The E2E harness closes the window to end a run.
  if (process.platform !== 'darwin' || isE2E) app.quit()
})

app.on('will-quit', (event) => {
  if (quitting || !state) return
  quitting = true
  event.preventDefault()
  const current = state
  state = null
  current.bridge.dispose()
  current.disposeRouter()
  void current.core
    .dispose()
    .catch((err: unknown) => {
      logger.warn('Core dispose failed during quit', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      logger.info('Quitting')
      app.exit(0)
    })
})
