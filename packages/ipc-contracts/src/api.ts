import type { JobSnapshot, ProgressEvent } from '@devmig/model'
import type { IpcRequest, IpcResponse } from './channels'

export type Unsubscribe = () => void

/**
 * The ONLY surface exposed to the renderer as `window.devMigration`.
 * Each method maps 1:1 to a whitelisted channel. No generic invoke, no fs, no exec.
 */
export interface DevMigrationApi {
  projects: {
    selectDirectories(
      input?: IpcRequest<'projects:selectDirectories'>,
    ): Promise<IpcResponse<'projects:selectDirectories'>>
    scan(input: IpcRequest<'projects:scan'>): Promise<IpcResponse<'projects:scan'>>
  }
  backups: {
    selectOutputPath(
      input: IpcRequest<'backups:selectOutputPath'>,
    ): Promise<IpcResponse<'backups:selectOutputPath'>>
    create(input: IpcRequest<'backups:create'>): Promise<IpcResponse<'backups:create'>>
    selectFile(): Promise<IpcResponse<'backups:selectFile'>>
    readHeader(input: IpcRequest<'backups:readHeader'>): Promise<IpcResponse<'backups:readHeader'>>
    inspect(input: IpcRequest<'backups:inspect'>): Promise<IpcResponse<'backups:inspect'>>
    verify(input: IpcRequest<'backups:verify'>): Promise<IpcResponse<'backups:verify'>>
  }
  restore: {
    selectDestination(
      input?: IpcRequest<'restore:selectDestination'>,
    ): Promise<IpcResponse<'restore:selectDestination'>>
    previewRemap(
      input: IpcRequest<'restore:previewRemap'>,
    ): Promise<IpcResponse<'restore:previewRemap'>>
    plan(input: IpcRequest<'restore:plan'>): Promise<IpcResponse<'restore:plan'>>
    execute(input: IpcRequest<'restore:execute'>): Promise<IpcResponse<'restore:execute'>>
  }
  jobs: {
    get(jobId: string): Promise<JobSnapshot>
    cancel(jobId: string): Promise<JobSnapshot>
    list(): Promise<JobSnapshot[]>
    /** Subscribe to progress events for one job. Returns an unsubscribe function. */
    onProgress(jobId: string, listener: (event: ProgressEvent) => void): Unsubscribe
    /** Subscribe to state transitions (running/completed/failed/cancelled) for one job. */
    onState(jobId: string, listener: (snapshot: JobSnapshot) => void): Unsubscribe
    /** Convenience: resolves when the job reaches a terminal state. */
    waitFor(jobId: string): Promise<JobSnapshot>
  }
  system: {
    openInFinder(path: string): Promise<IpcResponse<'system:openInFinder'>>
    openInTerminal(path: string): Promise<IpcResponse<'system:openInTerminal'>>
    openExternal(url: string): Promise<IpcResponse<'system:openExternal'>>
    diagnostics(): Promise<IpcResponse<'system:diagnostics'>>
    copyDiagnostics(): Promise<IpcResponse<'system:copyDiagnostics'>>
    openLogs(): Promise<IpcResponse<'system:openLogs'>>
    suggestBackupName(): Promise<IpcResponse<'system:suggestBackupName'>>
    homeDir(): Promise<IpcResponse<'system:homeDir'>>
    pathExists(path: string): Promise<IpcResponse<'system:pathExists'>>
  }
  /** Static facts injected at preload time. */
  meta: {
    appVersion: string
    platform: string
    isE2E: boolean
  }
}

/** Renderer-side error thrown when an invoke returns an error envelope. Mirrors SerializedError. */
export class IpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly details?: Record<string, unknown>,
    public readonly recoverable = false,
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

declare global {
  interface Window {
    devMigration: DevMigrationApi
  }
}
