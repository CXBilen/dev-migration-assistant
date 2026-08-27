import {
  BackupHeaderInfo,
  BackupInspection,
  BackupRequest,
  BackupResult,
  Diagnostics,
  JobSnapshot,
  ProgressEvent,
  RestoreExecuteRequest,
  RestorePlan,
  RestorePlanRequest,
  RestoreResult,
  ScanSession,
  SerializedError,
  PathMapping,
  PathRemapReport,
} from '@devmig/model'
import { z } from 'zod'

/**
 * Every IPC operation is an entry here: request schema + response schema.
 * Main validates requests with `request`; preload/renderer validate responses with `response`.
 * Channel names are namespaced and there is NO generic tunnel.
 */
export const IpcChannels = {
  'projects:selectDirectories': {
    request: z.object({ title: z.string().optional(), defaultPath: z.string().optional() }),
    response: z.object({ paths: z.array(z.string()), cancelled: z.boolean() }),
  },
  'projects:scan': {
    request: z.object({
      paths: z.array(z.string()).min(1).max(50),
      includeGlobal: z.boolean().default(true),
    }),
    response: z.object({ jobId: z.string() }),
  },
  'backups:selectOutputPath': {
    request: z.object({ suggestedName: z.string() }),
    response: z.object({ path: z.string().nullable(), cancelled: z.boolean() }),
  },
  'backups:create': {
    request: BackupRequest,
    response: z.object({ jobId: z.string() }),
  },
  'backups:selectFile': {
    request: z.object({}),
    response: z.object({ path: z.string().nullable(), cancelled: z.boolean() }),
  },
  'backups:readHeader': {
    request: z.object({ path: z.string() }),
    response: BackupHeaderInfo,
  },
  'backups:inspect': {
    request: z.object({ path: z.string(), password: z.string().min(1) }),
    response: BackupInspection,
  },
  'backups:verify': {
    request: z.object({ path: z.string(), password: z.string().min(1) }),
    response: z.object({ jobId: z.string() }),
  },
  'restore:selectDestination': {
    request: z.object({ title: z.string().optional(), defaultPath: z.string().optional() }),
    response: z.object({ path: z.string().nullable(), cancelled: z.boolean() }),
  },
  'restore:previewRemap': {
    request: z.object({
      path: z.string(),
      password: z.string().min(1),
      mappings: z.array(PathMapping),
    }),
    response: PathRemapReport,
  },
  'restore:plan': {
    request: RestorePlanRequest,
    response: z.object({ jobId: z.string() }),
  },
  'restore:execute': {
    request: RestoreExecuteRequest,
    response: z.object({ jobId: z.string() }),
  },
  'jobs:get': {
    request: z.object({ jobId: z.string() }),
    response: JobSnapshot,
  },
  'jobs:cancel': {
    request: z.object({ jobId: z.string() }),
    response: JobSnapshot,
  },
  'jobs:list': {
    request: z.object({}),
    response: z.array(JobSnapshot),
  },
  'system:openInFinder': {
    request: z.object({ path: z.string() }),
    response: z.object({ ok: z.boolean() }),
  },
  'system:openInTerminal': {
    request: z.object({ path: z.string() }),
    response: z.object({ ok: z.boolean() }),
  },
  'system:openExternal': {
    request: z.object({ url: z.string().url() }),
    response: z.object({ ok: z.boolean() }),
  },
  'system:diagnostics': {
    request: z.object({}),
    response: Diagnostics,
  },
  'system:copyDiagnostics': {
    request: z.object({}),
    response: z.object({ ok: z.boolean() }),
  },
  'system:openLogs': {
    request: z.object({}),
    response: z.object({ ok: z.boolean() }),
  },
  'system:suggestBackupName': {
    request: z.object({}),
    response: z.object({ name: z.string(), defaultDirectory: z.string() }),
  },
  'system:homeDir': {
    request: z.object({}),
    response: z.object({ homeDir: z.string(), defaultProjectsDir: z.string() }),
  },
  'system:pathExists': {
    request: z.object({ path: z.string() }),
    response: z.object({ exists: z.boolean(), isDirectory: z.boolean(), isEmpty: z.boolean() }),
  },
} as const

export type IpcChannelName = keyof typeof IpcChannels
export type IpcRequest<C extends IpcChannelName> = z.input<(typeof IpcChannels)[C]['request']>
export type IpcResponse<C extends IpcChannelName> = z.output<(typeof IpcChannels)[C]['response']>

/** Push events from main to renderer (renderer subscribes; it can never send on these). */
export const IpcEvents = {
  'jobs:progress': ProgressEvent,
  'jobs:state': JobSnapshot,
} as const
export type IpcEventName = keyof typeof IpcEvents
export type IpcEventPayload<E extends IpcEventName> = z.output<(typeof IpcEvents)[E]>

/** Wire envelope returned by every invoke — errors are values, never thrown across the bridge. */
export const IpcEnvelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: SerializedError }),
])
export type IpcEnvelope = z.infer<typeof IpcEnvelope>

/** Typed result shapes the renderer expects from job results. */
export const JobResultSchemas = {
  scan: ScanSession,
  backup: BackupResult,
  'restore-plan': RestorePlan,
  restore: RestoreResult,
  verify: z.object({ ok: z.boolean(), entries: z.number(), bytes: z.number() }),
  inspect: BackupInspection,
} as const
