/**
 * Builds the `window.devMigration` surface over a narrow ipcRenderer-like object.
 * Per-channel wrappers only: no generic invoke, no raw `send`/`on`, no event objects reach the page.
 * Kept separate from index.ts so it can be unit tested with a fake ipcRenderer.
 */
import {
  IpcChannels,
  IpcEnvelope,
  IpcEvents,
  type DevMigrationApi,
  type IpcChannelName,
  type IpcRequest,
  type IpcResponse,
  type Unsubscribe,
} from '@devmig/ipc-contracts'
import type { ErrorCode, JobSnapshot, SerializedError } from '@devmig/model'

/** The subset of Electron's ipcRenderer the bridge uses. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

export interface PreloadMeta {
  appVersion: string
  platform: string
  isE2E: boolean
}

/**
 * Error value rejected to the page. contextBridge copies plain objects but strips custom properties
 * from Error instances, so the IpcError shape (code, message, hint, details, recoverable) is delivered
 * as a frozen plain object that mirrors `IpcError` from @devmig/ipc-contracts.
 */
export interface BridgeError {
  name: 'IpcError'
  code: ErrorCode
  message: string
  hint?: string
  details?: Record<string, unknown>
  recoverable: boolean
}

export function bridgeError(error: SerializedError): BridgeError {
  const out: BridgeError = {
    name: 'IpcError',
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
  }
  if (error.hint !== undefined) out.hint = error.hint
  if (error.details !== undefined) out.details = error.details
  return Object.freeze(out)
}

const TERMINAL: ReadonlySet<JobSnapshot['status']> = new Set(['completed', 'failed', 'cancelled'])

/** Rejects the current call with a BridgeError (a plain object by design, see above). */
function raise(error: SerializedError): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- contextBridge strips custom properties from Error instances; the page needs `code`
  throw bridgeError(error)
}

/** Reads `--app-version=<v>` and `--devmig-e2e` from the preload argv (set by main via additionalArguments). */
export function readPreloadMeta(argv: readonly string[], platform: string): PreloadMeta {
  let appVersion = '0.0.0'
  let isE2E = false
  for (const arg of argv) {
    if (arg.startsWith('--app-version='))
      appVersion = arg.slice('--app-version='.length) || appVersion
    else if (arg === '--devmig-e2e') isE2E = true
  }
  return { appVersion, platform, isE2E }
}

export function createDevMigrationApi(ipc: IpcRendererLike, meta: PreloadMeta): DevMigrationApi {
  async function call<C extends IpcChannelName>(
    channel: C,
    input: IpcRequest<C>,
  ): Promise<IpcResponse<C>> {
    let raw: unknown
    try {
      raw = await ipc.invoke(channel, input)
    } catch (err) {
      raise({
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : 'The request could not be delivered.',
        recoverable: false,
      })
    }
    const envelope = IpcEnvelope.safeParse(raw)
    if (!envelope.success) {
      raise({
        code: 'UNKNOWN',
        message: 'Malformed response from the main process.',
        recoverable: false,
      })
    }
    if (!envelope.data.ok) raise(envelope.data.error)
    const parsed = IpcChannels[channel].response.safeParse(envelope.data.data)
    if (!parsed.success) {
      raise({
        code: 'UNKNOWN',
        message: `Response for ${channel} did not match the contract.`,
        recoverable: false,
      })
    }
    return parsed.data as IpcResponse<C>
  }

  function subscribe<E extends keyof typeof IpcEvents>(
    channel: E,
    jobId: string,
    listener: (payload: (typeof IpcEvents)[E]['_output']) => void,
  ): Unsubscribe {
    const schema = IpcEvents[channel]
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = schema.safeParse(payload)
      if (!parsed.success) return
      const data = parsed.data
      const id = 'jobId' in data ? data.jobId : data.id
      if (id !== jobId) return
      listener(data)
    }
    ipc.on(channel, wrapped)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipc.removeListener(channel, wrapped)
    }
  }

  const jobs: DevMigrationApi['jobs'] = {
    get: (jobId) => call('jobs:get', { jobId }),
    cancel: (jobId) => call('jobs:cancel', { jobId }),
    list: () => call('jobs:list', {}),
    onProgress: (jobId, listener) => subscribe('jobs:progress', jobId, listener),
    onState: (jobId, listener) => subscribe('jobs:state', jobId, listener),
    waitFor: (jobId) =>
      new Promise<JobSnapshot>((resolve, reject) => {
        let settled = false
        const finish = (snapshot: JobSnapshot): void => {
          if (settled) return
          settled = true
          off()
          resolve(snapshot)
        }
        const off = subscribe('jobs:state', jobId, (snapshot) => {
          if (TERMINAL.has(snapshot.status)) finish(snapshot)
        })
        call('jobs:get', { jobId })
          .then((snapshot) => {
            if (TERMINAL.has(snapshot.status)) finish(snapshot)
          })
          .catch((err: unknown) => {
            if (settled) return
            settled = true
            off()
            reject(
              err instanceof Error
                ? err
                : new Error(String((err as { message?: unknown })?.message ?? err)),
            )
          })
      }),
  }

  return {
    projects: {
      selectDirectories: (input = {}) => call('projects:selectDirectories', input),
      scan: (input) => call('projects:scan', input),
    },
    backups: {
      selectOutputPath: (input) => call('backups:selectOutputPath', input),
      create: (input) => call('backups:create', input),
      selectFile: () => call('backups:selectFile', {}),
      readHeader: (input) => call('backups:readHeader', input),
      inspect: (input) => call('backups:inspect', input),
      verify: (input) => call('backups:verify', input),
    },
    restore: {
      selectDestination: (input = {}) => call('restore:selectDestination', input),
      previewRemap: (input) => call('restore:previewRemap', input),
      plan: (input) => call('restore:plan', input),
      execute: (input) => call('restore:execute', input),
    },
    jobs,
    system: {
      openInFinder: (path) => call('system:openInFinder', { path }),
      openInTerminal: (path) => call('system:openInTerminal', { path }),
      openExternal: (url) => call('system:openExternal', { url }),
      diagnostics: () => call('system:diagnostics', {}),
      copyDiagnostics: () => call('system:copyDiagnostics', {}),
      openLogs: () => call('system:openLogs', {}),
      suggestBackupName: () => call('system:suggestBackupName', {}),
      homeDir: () => call('system:homeDir', {}),
      pathExists: (path) => call('system:pathExists', { path }),
    },
    meta: { appVersion: meta.appVersion, platform: meta.platform, isE2E: meta.isE2E },
  }
}
