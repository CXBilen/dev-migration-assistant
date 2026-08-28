import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CoreServices, Environment } from '@devmig/core'
import { createLogger, type Exec } from '@devmig/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = await vi.hoisted(async () =>
  (await import('../testing/electron-mock')).createElectronMock(),
)
vi.mock('electron', () => mock)

const {
  allowedExternalUrl,
  createSystemService,
  defaultProjectsDir,
  machineLabelFromHostname,
  suggestBackupName,
} = await import('./system')

const logger = createLogger(() => {})

function service(homeDir: string, execCalls: { file: string; args: readonly string[] }[] = []) {
  const exec: Exec = (file, args) => {
    execCalls.push({ file, args })
    return Promise.resolve({
      stdout: '',
      stderr: '',
      stdoutBuffer: Buffer.alloc(0),
      exitCode: 0,
      failed: false,
      timedOut: false,
      command: file,
    })
  }
  const env = { homeDir, exec } as unknown as Environment
  const core = {
    diagnostics: vi.fn(
      (input: { appVersion: string; electronVersion: string | null; logsDirectory: string }) => ({
        appVersion: input.appVersion,
        electronVersion: input.electronVersion,
        logsDirectory: input.logsDirectory,
        machine: { tools: [], userName: 'alice' },
        searchPaths: ['/opt/homebrew/bin', '/Users/alice/.local/bin'],
        providers: [
          {
            id: 'git',
            details: {
              apiKey: 'sk-ant-abcdefghijklmnopqrstuvwxyz',
              githubToken: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
              awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
              header: 'Authorization: Bearer qrstuvwxyz0123456789abcdefghijkl',
              envLine: 'DATABASE_PASSWORD=hunter22correcthorse',
              jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
            },
          },
        ],
      }),
    ),
  } as unknown as Pick<CoreServices, 'diagnostics'>
  return {
    core,
    system: createSystemService({
      env,
      core,
      appVersion: '1.2.3',
      electronVersion: '44.0.0',
      logsDirectory: () => path.join(homeDir, 'logs'),
      logFile: () => path.join(homeDir, 'logs', 'main.log'),
      documentsDirectory: () => path.join(homeDir, 'Documents'),
      logger,
      hostname: () => 'Cems-MacBook-Pro.local',
      now: () => new Date(2026, 7, 28, 10, 0, 0),
      platform: 'darwin',
    }),
  }
}

describe('openExternal allow-list', () => {
  it('accepts only https links to the allow-listed hosts', () => {
    for (const ok of [
      'https://github.com/CXBilen/dev-migration-assistant',
      'https://docs.anthropic.com/en/docs',
      'https://code.claude.com/docs',
      'https://www.electronjs.org/docs/latest/',
    ]) {
      expect(allowedExternalUrl(ok)?.href, ok).toBe(new URL(ok).href)
    }
    for (const bad of [
      'http://github.com/x',
      'https://github.com.evil.com/x',
      'https://evil.com/github.com',
      'https://user:pw@github.com/x',
      'https://github.com:8443/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(allowedExternalUrl(bad), bad).toBeNull()
    }
  })

  it('opens allowed links through shell.openExternal and refuses the rest', async () => {
    const { system } = service('/Users/alice')
    mock.shell.opened.length = 0
    await expect(system.openExternal('https://github.com/CXBilen')).resolves.toEqual({ ok: true })
    expect(mock.shell.opened).toEqual(['https://github.com/CXBilen'])
    await expect(system.openExternal('https://evil.com/')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(mock.shell.opened).toHaveLength(1)
  })
})

describe('suggestBackupName', () => {
  it('sanitises the host name to letters, digits and dashes and appends the date', () => {
    expect(machineLabelFromHostname('Cems-MacBook-Pro.local')).toBe('Cems-MacBook-Pro')
    expect(machineLabelFromHostname("Cem's  Mac_Book ✨.local")).toBe('Cem-s-Mac-Book')
    expect(machineLabelFromHostname('---')).toBe('Mac')
    expect(machineLabelFromHostname('')).toBe('Mac')
    expect(machineLabelFromHostname('a'.repeat(100)).length).toBe(40)
    expect(suggestBackupName('Cems-MacBook-Pro.local', new Date(2026, 7, 28))).toBe(
      'Cems-MacBook-Pro-Development-2026-08-28',
    )
  })

  it('returns the name without extension and the Documents folder as default directory', async () => {
    const { system } = service('/Users/alice')
    expect(await system.suggestBackupName()).toEqual({
      name: 'Cems-MacBook-Pro-Development-2026-08-28',
      defaultDirectory: '/Users/alice/Documents',
    })
  })
})

describe('filesystem probes and OS integration', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devmig-system-')))
    mock.shell.revealed.length = 0
    mock.shell.openedPaths.length = 0
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('defaultProjectsDir prefers ~/Documents/GitHub, then ~/Developer, then ~', async () => {
    expect(await defaultProjectsDir(tmp)).toBe(tmp)
    await fs.mkdir(path.join(tmp, 'Developer'))
    expect(await defaultProjectsDir(tmp)).toBe(path.join(tmp, 'Developer'))
    await fs.mkdir(path.join(tmp, 'Documents', 'GitHub'), { recursive: true })
    expect(await defaultProjectsDir(tmp)).toBe(path.join(tmp, 'Documents', 'GitHub'))
  })

  it('pathExists reports existence, directory-ness and emptiness', async () => {
    const { system } = service(tmp)
    await fs.mkdir(path.join(tmp, 'empty'))
    await fs.mkdir(path.join(tmp, 'full'))
    await fs.writeFile(path.join(tmp, 'full', 'f.txt'), 'x')
    expect(await system.pathExists(path.join(tmp, 'missing'))).toEqual({
      exists: false,
      isDirectory: false,
      isEmpty: true,
    })
    expect(await system.pathExists(path.join(tmp, 'empty'))).toEqual({
      exists: true,
      isDirectory: true,
      isEmpty: true,
    })
    expect(await system.pathExists(path.join(tmp, 'full'))).toEqual({
      exists: true,
      isDirectory: true,
      isEmpty: false,
    })
    expect(await system.pathExists(path.join(tmp, 'full', 'f.txt'))).toEqual({
      exists: true,
      isDirectory: false,
      isEmpty: false,
    })
    await expect(system.pathExists('relative')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('openInFinder reveals existing paths only', async () => {
    const { system } = service(tmp)
    await fs.writeFile(path.join(tmp, 'a.devbackup'), 'x')
    expect(await system.openInFinder(path.join(tmp, 'a.devbackup'))).toEqual({ ok: true })
    expect(mock.shell.revealed).toEqual([path.join(tmp, 'a.devbackup')])
    await expect(system.openInFinder(path.join(tmp, 'nope'))).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
    })
  })

  it('openInTerminal runs /usr/bin/open with an argument array after verifying the directory', async () => {
    const calls: { file: string; args: readonly string[] }[] = []
    const { system } = service(tmp, calls)
    await fs.mkdir(path.join(tmp, 'repo'))
    await fs.writeFile(path.join(tmp, 'file.txt'), 'x')
    expect(await system.openInTerminal(path.join(tmp, 'repo'))).toEqual({ ok: true })
    expect(calls).toEqual([
      { file: '/usr/bin/open', args: ['-b', 'com.apple.Terminal', path.join(tmp, 'repo')] },
    ])
    await expect(system.openInTerminal(path.join(tmp, 'file.txt'))).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    })
    await expect(system.openInTerminal(path.join(tmp, 'missing'))).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
    })
    await expect(system.openInTerminal('-rf')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(calls).toHaveLength(1)
  })

  it('diagnostics are copied to the clipboard with secrets redacted', async () => {
    const { system, core } = service(tmp)
    await system.copyDiagnostics()
    expect(core.diagnostics).toHaveBeenCalledWith({
      appVersion: '1.2.3',
      electronVersion: '44.0.0',
      logsDirectory: path.join(tmp, 'logs'),
    })
    expect(mock.clipboard.text).toContain('"appVersion": "1.2.3"')
    for (const secret of [
      'abcdefghijklmnop',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'qrstuvwxyz0123456789abcdefghijkl',
      'hunter22correcthorse',
      'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ]) {
      expect(mock.clipboard.text, `leaked ${secret}`).not.toContain(secret)
    }
    expect(mock.clipboard.text).toContain('[REDACTED]')
    // Non-secret diagnostics survive redaction.
    expect(mock.clipboard.text).toContain('/opt/homebrew/bin')
  })

  it('openLogs reveals the log file when present and opens the folder otherwise', async () => {
    const { system } = service(tmp)
    expect(await system.openLogs()).toEqual({ ok: true })
    expect(mock.shell.openedPaths).toEqual([path.join(tmp, 'logs')])
    await fs.writeFile(path.join(tmp, 'logs', 'main.log'), 'log')
    expect(await system.openLogs()).toEqual({ ok: true })
    expect(mock.shell.revealed).toEqual([path.join(tmp, 'logs', 'main.log')])
  })
})
