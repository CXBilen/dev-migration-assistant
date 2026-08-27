import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const exposed: { key: string; api: unknown }[] = []
  const listeners = new Map<string, unknown[]>()
  return {
    exposed,
    listeners,
    contextBridge: {
      exposeInMainWorld: (key: string, api: unknown) => {
        exposed.push({ key, api })
      },
    },
    ipcRenderer: {
      invoke: () => Promise.resolve({ ok: true, data: {} }),
      on: (channel: string, listener: unknown) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
      },
      removeListener: (channel: string, listener: unknown) => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((l) => l !== listener),
        )
      },
    },
  }
})
vi.mock('electron', () => electron)

describe('preload entry', () => {
  it('exposes window.devMigration only, with the meta parsed from argv', async () => {
    process.argv.push('--app-version=9.9.9')
    await import('./index')
    expect(electron.exposed).toHaveLength(1)
    const { key, api } = electron.exposed[0]!
    expect(key).toBe('devMigration')
    const surface = api as Record<string, unknown>
    expect(Object.keys(surface).sort()).toEqual([
      'backups',
      'jobs',
      'meta',
      'projects',
      'restore',
      'system',
    ])
    expect(surface.meta).toEqual({ appVersion: '9.9.9', platform: process.platform, isE2E: false })
    // No ipcRenderer, no generic invoke, no Node globals slip through.
    expect(JSON.stringify(Object.keys(surface))).not.toMatch(/ipc|invoke|require|process/)
    const jobs = surface.jobs as { onProgress: (id: string, l: () => void) => () => void }
    const off = jobs.onProgress('job_1', () => {})
    expect(electron.listeners.get('jobs:progress')).toHaveLength(1)
    off()
    expect(electron.listeners.get('jobs:progress')).toHaveLength(0)
  })
})
