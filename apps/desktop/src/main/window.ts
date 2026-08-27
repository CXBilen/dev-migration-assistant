/**
 * Window factory and navigation lockdown (ADR-0007, docs/research/electron-security.md §2 and §5).
 * Every webPreferences key is set explicitly so a future Electron default change cannot weaken the app.
 */
import { BrowserWindow, app, type WebContents } from 'electron'
import type { Logger } from '@devmig/shared'

export interface MainWindowOptions {
  preloadPath: string
  /** Vite dev server URL (development only); null loads the bundled page. */
  rendererUrl: string | null
  /** Absolute path of the bundled renderer index.html. */
  rendererFile: string
  /** Extra argv entries visible to the preload (`--app-version=…`, `--devmig-e2e`). */
  additionalArguments: string[]
  isPackaged: boolean
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Dev Migration Assistant',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: options.preloadPath,
      additionalArguments: options.additionalArguments,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      disableBlinkFeatures: 'Auxclick',
      spellcheck: false,
      safeDialogs: true,
      devTools: !options.isPackaged,
    },
  })
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  if (options.rendererUrl && !options.isPackaged) {
    void win.loadURL(options.rendererUrl)
  } else {
    void win.loadFile(options.rendererFile)
  }
  return win
}

/** Denies navigation, redirects, window creation and <webview> attachment for one WebContents. */
export function lockDownWebContents(contents: WebContents, logger: Logger): void {
  const deny = (what: string) => (event: { preventDefault: () => void }, url?: string) => {
    event.preventDefault()
    logger.warn(`Blocked ${what}`, { url: typeof url === 'string' ? url : undefined })
  }
  contents.on('will-navigate', deny('navigation'))
  contents.on('will-frame-navigate', (event) => deny('frame navigation')(event, event.url))
  contents.on('will-redirect', deny('redirect'))
  contents.on('will-attach-webview', (event) => deny('webview attachment')(event))
  contents.setWindowOpenHandler(({ url }) => {
    logger.warn('Blocked window.open', { url })
    return { action: 'deny' }
  })
}

/** Registers the lockdown for every WebContents the app will ever create. Call before `ready`. */
export function installWebContentsLockdown(logger: Logger): void {
  app.on('web-contents-created', (_event, contents) => {
    lockDownWebContents(contents, logger)
  })
}
