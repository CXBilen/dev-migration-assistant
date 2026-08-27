import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IpcChannels } from '@devmig/ipc-contracts'
import type { CoreServices } from '@devmig/core'
import { createLogger } from '@devmig/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovedPaths } from '../../services/approved-paths'
import type { DialogService } from '../../services/dialogs'
import type { SystemService } from '../../services/system'
import { createFakeWebContents, createInvokeEvent } from '../../testing/electron-mock'

const mock = await vi.hoisted(async () =>
  (await import('../../testing/electron-mock')).createElectronMock(),
)
vi.mock('electron', () => mock)

const { createRouter } = await import('../router')
const { buildHandlerMap, registerAllHandlers } = await import('./index')

const logger = createLogger(() => {})

interface Fakes {
  core: CoreServices
  dialogs: DialogService
  system: SystemService
  approved: ApprovedPaths
  started: { kind: string; phase: string | undefined }[]
  homeDir: string
}

function fakes(homeDir: string): Fakes {
  const started: { kind: string; phase: string | undefined }[] = []
  const jobs = {
    start: vi.fn((kind: string, _runner: unknown, phase?: string) => {
      started.push({ kind, phase })
      return { id: `job_${started.length}` }
    }),
    get: vi.fn((id: string) => ({ id })),
    cancel: vi.fn((id: string) => ({ id })),
    list: vi.fn(() => []),
  }
  const core = {
    env: { homeDir },
    jobs,
    scanner: { scan: vi.fn() },
    backup: { run: vi.fn() },
    restore: {
      readHeader: vi.fn((p: string) => ({ path: p })),
      inspect: vi.fn((p: string) => ({ path: p })),
      previewRemap: vi.fn((_p: string, _pw: string, mappings: unknown) => ({ mappings })),
      plan: vi.fn(),
      execute: vi.fn(),
      verify: vi.fn(),
    },
  } as unknown as CoreServices
  const dialogs: DialogService = {
    selectDirectories: vi.fn(() =>
      Promise.resolve({
        paths: [`${homeDir}/Documents/GitHub/demo`],
        cancelled: false,
      }),
    ),
    selectBackupFile: vi.fn(() =>
      Promise.resolve({ path: `${homeDir}/b.devbackup`, cancelled: false }),
    ),
    selectOutputPath: vi.fn(() =>
      Promise.resolve({
        path: `${homeDir}/Documents/out.devbackup`,
        cancelled: false,
      }),
    ),
    selectDestination: vi.fn(() =>
      Promise.resolve({ path: '/Volumes/External/demo', cancelled: false }),
    ),
  }
  const system = {
    suggestBackupName: vi.fn(() =>
      Promise.resolve({
        name: 'Mac-Development-2026-08-28',
        defaultDirectory: `${homeDir}/Documents`,
      }),
    ),
    homeDir: vi.fn(() => Promise.resolve({ homeDir, defaultProjectsDir: homeDir })),
  } as unknown as SystemService
  return { core, dialogs, system, approved: new ApprovedPaths(homeDir), started, homeDir }
}

describe('handler map', () => {
  it('covers every IpcChannels entry exactly once and registers nothing else', () => {
    const f = fakes('/Users/alice')
    const map = buildHandlerMap({ ...f, logger })
    expect(Object.keys(map).sort()).toEqual(Object.keys(IpcChannels).sort())
    mock.ipcMain.handlers.clear()
    const router = createRouter({ isTrustedSender: () => true, logger, windowFor: () => null })
    const registered = registerAllHandlers(router, { ...f, logger })
    expect([...registered].sort()).toEqual(Object.keys(IpcChannels).sort())
    expect([...mock.ipcMain.handlers.keys()].sort()).toEqual(Object.keys(IpcChannels).sort())
    router.dispose()
  })
})

describe('write destinations come only from dialogs', () => {
  let f: Fakes
  const ctx = {
    event: createInvokeEvent(createFakeWebContents('file:///a')) as never,
    window: null,
  }

  beforeEach(() => {
    f = fakes('/Users/alice')
  })

  it('backups:create refuses an output path the Save dialog did not hand out', () => {
    const map = buildHandlerMap({ ...f, logger })
    expect(() =>
      map['backups:create'](
        {
          scanId: 's',
          selectedArtifactIds: [],
          outputPath: '/Users/alice/Documents/forged.devbackup',
          password: 'correct horse battery',
          label: 'x',
        },
        ctx,
      ),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
    expect(f.started).toEqual([])
  })

  it('backups:create accepts the path returned by backups:selectOutputPath', async () => {
    const map = buildHandlerMap({ ...f, logger })
    const picked = await map['backups:selectOutputPath']({ suggestedName: 'x' }, ctx)
    expect(picked.path).toBe('/Users/alice/Documents/out.devbackup')
    const res = map['backups:create'](
      {
        scanId: 's',
        selectedArtifactIds: [],
        outputPath: picked.path!,
        password: 'correct horse battery',
        label: 'x',
      },
      ctx,
    )
    expect(res).toEqual({ jobId: 'job_1' })
    expect(f.started).toEqual([{ kind: 'backup', phase: 'COLLECTING' }])
  })

  it('restore mappings must be absolute and inside home, /Users or /Volumes unless dialog-approved', async () => {
    const map = buildHandlerMap({ ...f, logger })
    const base = { path: '/Users/alice/b.devbackup', password: 'pw' }
    const good = await map['restore:previewRemap'](
      {
        ...base,
        mappings: [{ projectId: 'p', oldPath: '/Users/old/demo', newPath: '~/Developer/demo' }],
      },
      ctx,
    )
    expect(good).toEqual({
      mappings: [
        { projectId: 'p', oldPath: '/Users/old/demo', newPath: '/Users/alice/Developer/demo' },
      ],
    })
    for (const bad of [
      'relative/demo',
      '/tmp/demo',
      '/Users',
      '/Users/alice',
      '/private/etc/demo',
      '/Users/alice/../x',
    ]) {
      await expect(
        map['restore:previewRemap'](
          { ...base, mappings: [{ projectId: 'p', oldPath: '/Users/old/demo', newPath: bad }] },
          ctx,
        ),
      ).rejects.toSatisfy((err: { code: string }) =>
        ['INVALID_INPUT', 'PATH_OUTSIDE_ALLOWED_ROOT'].includes(err.code),
      )
    }
    // A folder picked through the native dialog is accepted even outside the default roots.
    const picked = await map['restore:selectDestination']({}, ctx)
    expect(picked.path).toBe('/Volumes/External/demo')
    f.approved.approve('/opt/somewhere/demo')
    const approved = await map['restore:previewRemap'](
      {
        ...base,
        mappings: [{ projectId: 'p', oldPath: '/Users/old/demo', newPath: '/opt/somewhere/demo' }],
      },
      ctx,
    )
    expect(approved).toEqual({
      mappings: [{ projectId: 'p', oldPath: '/Users/old/demo', newPath: '/opt/somewhere/demo' }],
    })
  })

  it('restore:plan and restore:execute start the right jobs', async () => {
    const map = buildHandlerMap({ ...f, logger })
    const plan = await map['restore:plan'](
      {
        backupPath: '/Users/alice/b.devbackup',
        password: 'pw',
        mappings: [],
        selectedArtifactIds: ['a'],
        options: { defaultCollisionPolicy: 'skip', includeGlobal: false },
      },
      ctx,
    )
    const exec = map['restore:execute']({ planId: 'plan_1', collisionDecisions: {} }, ctx)
    expect(plan).toEqual({ jobId: 'job_1' })
    expect(exec).toEqual({ jobId: 'job_2' })
    expect(f.started).toEqual([
      { kind: 'restore-plan', phase: 'INSPECT' },
      { kind: 'restore', phase: 'STAGE' },
    ])
  })
})

describe('projects:scan', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devmig-handlers-'))
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('dedupes, expands ~ and rejects relative or NUL paths before starting the scan job', () => {
    const f = fakes(tmp)
    const map = buildHandlerMap({ ...f, logger })
    const ctx = {
      event: createInvokeEvent(createFakeWebContents('file:///a')) as never,
      window: null,
    }
    const res = map['projects:scan'](
      { paths: ['~/demo', `${tmp}/demo`, `${tmp}/demo/`], includeGlobal: true },
      ctx,
    )
    expect(res).toEqual({ jobId: 'job_1' })
    expect(f.started).toEqual([{ kind: 'scan', phase: 'DISCOVERING' }])
    expect(() => map['projects:scan']({ paths: ['relative'], includeGlobal: true }, ctx)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
    expect(() => map['projects:scan']({ paths: ['/a\0b'], includeGlobal: true }, ctx)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })
})
