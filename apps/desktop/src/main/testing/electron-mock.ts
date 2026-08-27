/**
 * Minimal in-memory stand-in for the `electron` module used by the main-process unit tests
 * (`vi.mock('electron', ...)`). Only the surface the main code touches is modelled; every call is
 * recorded so tests can assert on it. No real Electron API is ever loaded.
 */
import { EventEmitter } from 'node:events'

export interface FakeWebFrame {
  url: string
}

export interface FakeWebContents extends EventEmitter {
  id: number
  mainFrame: FakeWebFrame
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  sent: { channel: string; payload: unknown }[]
  setWindowOpenHandler(handler: (details: { url: string }) => unknown): void
  windowOpenHandler: ((details: { url: string }) => unknown) | null
}

export interface FakeInvokeEvent {
  sender: FakeWebContents
  senderFrame: FakeWebFrame | null
  frameId: number
  processId: number
}

export type IpcHandleListener = (event: FakeInvokeEvent, payload: unknown) => unknown

let nextWebContentsId = 1

export function createFakeWebContents(
  url: string,
  options: { destroyed?: boolean } = {},
): FakeWebContents {
  const emitter = new EventEmitter() as FakeWebContents
  emitter.id = nextWebContentsId++
  emitter.mainFrame = { url }
  emitter.sent = []
  emitter.windowOpenHandler = null
  emitter.isDestroyed = () => options.destroyed ?? false
  emitter.send = (channel, payload) => {
    emitter.sent.push({ channel, payload })
  }
  emitter.setWindowOpenHandler = (handler) => {
    emitter.windowOpenHandler = handler
  }
  return emitter
}

export function createInvokeEvent(
  contents: FakeWebContents,
  frame: FakeWebFrame | null = contents.mainFrame,
): FakeInvokeEvent {
  return { sender: contents, senderFrame: frame, frameId: 1, processId: 1 }
}

export function createElectronMock() {
  const handlers = new Map<string, IpcHandleListener>()
  const ipcMain = {
    handle: (channel: string, listener: IpcHandleListener) => {
      if (handlers.has(channel))
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      handlers.set(channel, listener)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    },
    handlers,
  }

  const dialogCalls: { method: string; window: unknown; options: unknown }[] = []
  const dialog = {
    calls: dialogCalls,
    nextOpen: { canceled: true, filePaths: [] as string[] },
    nextSave: { canceled: true, filePath: '' },
    showOpenDialog: (winOrOptions: unknown, maybeOptions?: unknown) => {
      const [win, options] =
        maybeOptions === undefined ? [null, winOrOptions] : [winOrOptions, maybeOptions]
      dialogCalls.push({ method: 'showOpenDialog', window: win, options })
      return Promise.resolve(dialog.nextOpen)
    },
    showSaveDialog: (winOrOptions: unknown, maybeOptions?: unknown) => {
      const [win, options] =
        maybeOptions === undefined ? [null, winOrOptions] : [winOrOptions, maybeOptions]
      dialogCalls.push({ method: 'showSaveDialog', window: win, options })
      return Promise.resolve(dialog.nextSave)
    },
  }

  const shell = {
    opened: [] as string[],
    revealed: [] as string[],
    openedPaths: [] as string[],
    openPathResult: '',
    openExternal: (url: string) => {
      shell.opened.push(url)
      return Promise.resolve()
    },
    showItemInFolder: (p: string) => {
      shell.revealed.push(p)
    },
    openPath: (p: string) => {
      shell.openedPaths.push(p)
      return Promise.resolve(shell.openPathResult)
    },
  }

  const clipboard = {
    text: '',
    writeText: (text: string) => {
      clipboard.text = text
    },
    readText: () => clipboard.text,
  }

  const appEmitter = new EventEmitter()
  const app = Object.assign(appEmitter, {
    name: 'Dev Migration Assistant',
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    getPath: (name: string) => `/tmp/fake-electron/${name}`,
    setPath: () => {},
    setAppLogsPath: () => {},
    enableSandbox: () => {},
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    quit: () => {},
    exit: () => {},
    setAboutPanelOptions: () => {},
  })

  const windows: { webContents: FakeWebContents; isDestroyed: () => boolean }[] = []
  const BrowserWindow = {
    windows,
    getAllWindows: () => windows,
    fromWebContents: (contents: FakeWebContents) =>
      windows.find((w) => w.webContents === contents) ?? null,
  }

  const Menu = {
    template: null as unknown,
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: (menu: unknown) => {
      Menu.template = menu
    },
  }

  const session = {
    defaultSession: {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
    },
  }

  return { ipcMain, dialog, shell, clipboard, app, BrowserWindow, Menu, session }
}

export type ElectronMock = ReturnType<typeof createElectronMock>
