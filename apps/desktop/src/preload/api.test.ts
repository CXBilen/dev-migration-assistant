import type { JobSnapshot, ProgressEvent } from '@devmig/model'
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, createDevMigrationApi, readPreloadMeta, type IpcRendererLike } from './api'

type Listener = (event: unknown, ...args: unknown[]) => void

function fakeIpc(responses: Record<string, unknown> = {}) {
  const listeners = new Map<string, Listener[]>()
  const invocations: { channel: string; args: unknown[] }[] = []
  const ipc: IpcRendererLike = {
    invoke: (channel, ...args) => {
      invocations.push({ channel, args })
      const response = responses[channel]
      if (response instanceof Error) return Promise.reject(response)
      return Promise.resolve(response ?? { ok: true, data: {} })
    },
    on: (channel, listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
    },
    removeListener: (channel, listener) => {
      listeners.set(
        channel,
        (listeners.get(channel) ?? []).filter((l) => l !== listener),
      )
    },
  }
  const emit = (channel: string, payload: unknown): void => {
    for (const l of listeners.get(channel) ?? []) l({}, payload)
  }
  return { ipc, listeners, invocations, emit }
}

const meta = { appVersion: '1.2.3', platform: 'darwin', isE2E: false }

function snapshot(id: string, status: JobSnapshot['status']): JobSnapshot {
  return { id, kind: 'scan', status, phase: 'X', message: '', startedAt: 'now', recentEvents: [] }
}

describe('preload API surface', () => {
  it('exposes exactly the DevMigrationApi namespaces and methods, nothing else', () => {
    const { ipc } = fakeIpc()
    const api = createDevMigrationApi(ipc, meta) as unknown as Record<
      string,
      Record<string, unknown>
    >
    expect(Object.keys(api).sort()).toEqual([
      'backups',
      'jobs',
      'meta',
      'projects',
      'restore',
      'system',
    ])
    expect(Object.keys(api.projects!).sort()).toEqual(['scan', 'selectDirectories'])
    expect(Object.keys(api.backups!).sort()).toEqual([
      'create',
      'inspect',
      'readHeader',
      'selectFile',
      'selectOutputPath',
      'verify',
    ])
    expect(Object.keys(api.restore!).sort()).toEqual([
      'execute',
      'plan',
      'previewRemap',
      'selectDestination',
    ])
    expect(Object.keys(api.jobs!).sort()).toEqual([
      'cancel',
      'get',
      'list',
      'onProgress',
      'onState',
      'waitFor',
    ])
    expect(Object.keys(api.system!).sort()).toEqual([
      'copyDiagnostics',
      'diagnostics',
      'homeDir',
      'openExternal',
      'openInFinder',
      'openInTerminal',
      'openLogs',
      'pathExists',
      'suggestBackupName',
    ])
    expect(api.meta).toEqual({ appVersion: '1.2.3', platform: 'darwin', isE2E: false })
    for (const ns of ['projects', 'backups', 'restore', 'jobs', 'system']) {
      for (const value of Object.values(api[ns]!)) expect(typeof value).toBe('function')
    }
    expect('invoke' in api).toBe(false)
    expect('ipcRenderer' in api).toBe(false)
  })

  it('reads meta from additionalArguments', () => {
    expect(
      readPreloadMeta(['/electron', '--app-version=0.1.0-alpha.1', '--devmig-e2e'], 'darwin'),
    ).toEqual({
      appVersion: '0.1.0-alpha.1',
      platform: 'darwin',
      isE2E: true,
    })
    expect(readPreloadMeta([], 'linux')).toEqual({
      appVersion: '0.0.0',
      platform: 'linux',
      isE2E: false,
    })
  })
})

describe('invoke wrappers', () => {
  it('sends the input on the right channel and unwraps validated responses', async () => {
    const { ipc, invocations } = fakeIpc({
      'system:homeDir': {
        ok: true,
        data: { homeDir: '/Users/a', defaultProjectsDir: '/Users/a/Developer' },
      },
      'projects:scan': { ok: true, data: { jobId: 'job_1' } },
    })
    const api = createDevMigrationApi(ipc, meta)
    expect(await api.system.homeDir()).toEqual({
      homeDir: '/Users/a',
      defaultProjectsDir: '/Users/a/Developer',
    })
    expect(await api.projects.scan({ paths: ['/Users/a/demo'] })).toEqual({ jobId: 'job_1' })
    expect(invocations).toEqual([
      { channel: 'system:homeDir', args: [{}] },
      { channel: 'projects:scan', args: [{ paths: ['/Users/a/demo'] }] },
    ])
  })

  it('rejects with an IpcError-shaped value carrying code/hint/details for error envelopes', async () => {
    const { ipc } = fakeIpc({
      'backups:inspect': {
        ok: false,
        error: {
          code: 'ARCHIVE_AUTH_FAILED',
          message: 'nope',
          hint: 'Try again',
          recoverable: true,
        },
      },
    })
    const api = createDevMigrationApi(ipc, meta)
    const err = (await api.backups
      .inspect({ path: '/x', password: 'pw' })
      .catch((e: unknown) => e)) as Record<string, unknown>
    expect(err).toEqual({
      name: 'IpcError',
      code: 'ARCHIVE_AUTH_FAILED',
      message: 'nope',
      hint: 'Try again',
      recoverable: true,
    })
    expect(Object.isFrozen(err)).toBe(true)
  })

  it('rejects malformed envelopes, contract violations and transport failures as UNKNOWN', async () => {
    const { ipc } = fakeIpc({
      'system:homeDir': { nonsense: true },
      'jobs:list': { ok: true, data: 'not an array' },
      'system:openLogs': new Error('Error invoking remote method'),
    })
    const api = createDevMigrationApi(ipc, meta)
    await expect(api.system.homeDir()).rejects.toMatchObject({ code: 'UNKNOWN' })
    await expect(api.jobs.list()).rejects.toMatchObject({ code: 'UNKNOWN' })
    await expect(api.system.openLogs()).rejects.toMatchObject({
      code: 'UNKNOWN',
      message: 'Error invoking remote method',
    })
  })

  it('bridgeError copies optional fields only when present', () => {
    expect(bridgeError({ code: 'CANCELLED', message: 'x', recoverable: true })).toEqual({
      name: 'IpcError',
      code: 'CANCELLED',
      message: 'x',
      recoverable: true,
    })
  })
})

describe('job subscriptions', () => {
  const event = (jobId: string, message: string): ProgressEvent => ({
    jobId,
    phase: 'SCANNING',
    message,
    level: 'info',
    at: 'now',
  })

  it('filters events by jobId, validates payloads and never hands the event object to the page', () => {
    const { ipc, emit } = fakeIpc()
    const api = createDevMigrationApi(ipc, meta)
    const seen = vi.fn()
    const off = api.jobs.onProgress('job_1', seen)
    emit('jobs:progress', event('job_1', 'a'))
    emit('jobs:progress', event('job_2', 'b'))
    emit('jobs:progress', { jobId: 'job_1', broken: true })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job_1', message: 'a' }))
    expect(seen.mock.calls[0]).toHaveLength(1)
    off()
  })

  it('unsubscribe removes exactly the registered listener and is idempotent', () => {
    const { ipc, listeners, emit } = fakeIpc()
    const api = createDevMigrationApi(ipc, meta)
    const a = vi.fn()
    const b = vi.fn()
    const offA = api.jobs.onState('job_1', a)
    const offB = api.jobs.onState('job_1', b)
    expect(listeners.get('jobs:state')).toHaveLength(2)
    offA()
    offA()
    expect(listeners.get('jobs:state')).toHaveLength(1)
    emit('jobs:state', snapshot('job_1', 'running'))
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    offB()
    expect(listeners.get('jobs:state')).toHaveLength(0)
  })

  it('waitFor resolves from the initial lookup when the job already finished', async () => {
    const { ipc, listeners } = fakeIpc({
      'jobs:get': { ok: true, data: snapshot('job_1', 'completed') },
    })
    const api = createDevMigrationApi(ipc, meta)
    const result = await api.jobs.waitFor('job_1')
    expect(result.status).toBe('completed')
    expect(listeners.get('jobs:state')).toHaveLength(0)
  })

  it('waitFor resolves on the terminal state event and cleans up', async () => {
    const { ipc, listeners, emit } = fakeIpc({
      'jobs:get': { ok: true, data: snapshot('job_1', 'running') },
    })
    const api = createDevMigrationApi(ipc, meta)
    const pending = api.jobs.waitFor('job_1')
    await Promise.resolve()
    emit('jobs:state', snapshot('job_1', 'running'))
    emit('jobs:state', snapshot('job_1', 'failed'))
    expect((await pending).status).toBe('failed')
    expect(listeners.get('jobs:state')).toHaveLength(0)
  })

  it('waitFor rejects when the job cannot be looked up', async () => {
    const { ipc, listeners } = fakeIpc({
      'jobs:get': {
        ok: false,
        error: { code: 'JOB_NOT_FOUND', message: 'Unknown job', recoverable: false },
      },
    })
    const api = createDevMigrationApi(ipc, meta)
    await expect(api.jobs.waitFor('job_x')).rejects.toMatchObject({ message: 'Unknown job' })
    expect(listeners.get('jobs:state')).toHaveLength(0)
  })
})
