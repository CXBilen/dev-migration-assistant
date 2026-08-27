import { IpcChannels, type IpcChannelName } from '@devmig/ipc-contracts'
import { MigrationError, createLogger, type LogRecord } from '@devmig/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeWebContents, createInvokeEvent } from '../testing/electron-mock'

const mock = await vi.hoisted(async () =>
  (await import('../testing/electron-mock')).createElectronMock(),
)
vi.mock('electron', () => mock)

const { createRouter, IPC_CHANNEL_NAMES } = await import('./router')

function collectingLogger() {
  const records: LogRecord[] = []
  return { logger: createLogger((r) => records.push(r)), records }
}

describe('IPC router', () => {
  beforeEach(() => {
    mock.ipcMain.handlers.clear()
  })

  it('rejects untrusted senders with a PERMISSION_DENIED envelope and logs it', async () => {
    const { logger, records } = collectingLogger()
    const handler = vi.fn(() => ({ homeDir: '/Users/x', defaultProjectsDir: '/Users/x' }))
    const router = createRouter({ isTrustedSender: () => false, logger, windowFor: () => null })
    router.registerHandler('system:homeDir', handler)
    const listener = mock.ipcMain.handlers.get('system:homeDir')!
    const event = createInvokeEvent(createFakeWebContents('file:///app/index.html'))
    const envelope = await listener(event, {})
    expect(envelope).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(handler).not.toHaveBeenCalled()
    expect(records.some((r) => r.level === 'warn' && r.msg.includes('untrusted'))).toBe(true)
  })

  it('rejects payloads that fail the request schema without echoing them', async () => {
    const { logger } = collectingLogger()
    const handler = vi.fn(() => ({ jobId: 'job_1' }))
    const router = createRouter({ isTrustedSender: () => true, logger, windowFor: () => null })
    router.registerHandler('projects:scan', handler)
    const listener = mock.ipcMain.handlers.get('projects:scan')!
    const envelope = (await listener(createInvokeEvent(createFakeWebContents('file:///a')), {
      paths: [],
      secretPayload: 'sk-ant-should-not-echo-1234567890abcdef',
    })) as { ok: boolean; error?: { code: string; details?: { issues?: string[] } } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.code).toBe('INVALID_INPUT')
    expect(JSON.stringify(envelope)).not.toContain('should-not-echo')
    expect(envelope.error?.details?.issues?.length).toBeGreaterThan(0)
    expect(handler).not.toHaveBeenCalled()
  })

  it('applies request defaults before calling the handler and wraps the response', async () => {
    const { logger } = collectingLogger()
    const handler = vi.fn(() => ({ jobId: 'job_1' }))
    const router = createRouter({ isTrustedSender: () => true, logger, windowFor: () => null })
    router.registerHandler('projects:scan', handler)
    const listener = mock.ipcMain.handlers.get('projects:scan')!
    const envelope = await listener(createInvokeEvent(createFakeWebContents('file:///a')), {
      paths: ['/Users/alice/demo'],
    })
    expect(handler).toHaveBeenCalledWith(
      { paths: ['/Users/alice/demo'], includeGlobal: true },
      expect.objectContaining({ window: null }),
    )
    expect(envelope).toEqual({ ok: true, data: { jobId: 'job_1' } })
  })

  it('refuses responses outside the contract so unexpected data never leaks', async () => {
    const { logger, records } = collectingLogger()
    const router = createRouter({ isTrustedSender: () => true, logger, windowFor: () => null })
    router.registerHandler('system:homeDir', () => ({ homeDir: 42 }) as never)
    const listener = mock.ipcMain.handlers.get('system:homeDir')!
    const envelope = await listener(createInvokeEvent(createFakeWebContents('file:///a')), {})
    expect(envelope).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
    expect(records.some((r) => r.level === 'error')).toBe(true)
  })

  it('strips unknown keys from responses (zod object schemas drop extras)', async () => {
    const { logger } = collectingLogger()
    const router = createRouter({ isTrustedSender: () => true, logger, windowFor: () => null })
    router.registerHandler(
      'system:homeDir',
      () => ({ homeDir: '/Users/a', defaultProjectsDir: '/Users/a', leaked: 'x' }) as never,
    )
    const listener = mock.ipcMain.handlers.get('system:homeDir')!
    const envelope = await listener(createInvokeEvent(createFakeWebContents('file:///a')), {})
    expect(envelope).toEqual({
      ok: true,
      data: { homeDir: '/Users/a', defaultProjectsDir: '/Users/a' },
    })
  })

  it('serializes thrown MigrationErrors and plain errors into error envelopes', async () => {
    const { logger } = collectingLogger()
    const router = createRouter({ isTrustedSender: () => true, logger, windowFor: () => null })
    router.registerHandler('jobs:get', () => {
      throw new MigrationError('JOB_NOT_FOUND', 'Unknown job: x', { hint: 'Start a new job.' })
    })
    router.registerHandler('jobs:list', () => {
      throw new Error('boom token=sk-ant-abcdefghijklmnopqrstuvwxyz')
    })
    const trusted = createInvokeEvent(createFakeWebContents('file:///a'))
    const notFound = await mock.ipcMain.handlers.get('jobs:get')!(trusted, { jobId: 'x' })
    expect(notFound).toMatchObject({
      ok: false,
      error: { code: 'JOB_NOT_FOUND', hint: 'Start a new job.' },
    })
    const unknown = (await mock.ipcMain.handlers.get('jobs:list')!(trusted, {})) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(unknown.ok).toBe(false)
    expect(unknown.error.code).toBe('UNKNOWN')
    expect(unknown.error.message).not.toContain('abcdefghijklmnop')
  })

  it('refuses unknown channels and duplicate registrations', () => {
    const { logger } = collectingLogger()
    const router = createRouter({ isTrustedSender: () => true, logger, windowFor: () => null })
    router.registerHandler('jobs:list', () => [])
    expect(() => router.registerHandler('jobs:list', () => [])).toThrow(/twice/)
    expect(() => router.registerHandler('nope:channel' as IpcChannelName, () => [])).toThrow(
      /Unknown/,
    )
  })

  it('IPC_CHANNEL_NAMES mirrors IpcChannels exactly', () => {
    expect([...IPC_CHANNEL_NAMES].sort()).toEqual(Object.keys(IpcChannels).sort())
  })

  it('dispose removes every handler from ipcMain', () => {
    const { logger } = collectingLogger()
    const router = createRouter({ isTrustedSender: () => true, logger, windowFor: () => null })
    router.registerHandler('jobs:list', () => [])
    expect(mock.ipcMain.handlers.has('jobs:list')).toBe(true)
    router.dispose()
    expect(mock.ipcMain.handlers.has('jobs:list')).toBe(false)
    expect(router.registered()).toEqual([])
  })
})
