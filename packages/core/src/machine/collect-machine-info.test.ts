import { MachineInfo } from '@devmig/model'
import { describe, expect, it } from 'vitest'
import { createFakeExec } from '../testing/fake-exec'
import { collectMachineInfo } from './collect-machine-info'

describe('collectMachineInfo', () => {
  it('probes every tool in parallel with a 10 s timeout and stores no hostname', async () => {
    const exec = createFakeExec((file) => {
      switch (file) {
        case 'sw_vers':
          return { stdout: '15.6.1\n' }
        case 'node':
          return { stdout: 'v24.5.0\n' }
        case 'pnpm':
          return { stdout: '11.5.3\n' }
        case 'git':
          return { stdout: 'git version 2.50.1\n' }
        case 'claude':
          return { stdout: '2.1.247 (Claude Code)\n' }
        case 'gh':
          return {
            stdout:
              'gh version 2.80.0 (2026-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.80.0\n',
          }
        case 'brew':
          return { stdout: 'Homebrew 5.0.0\n' }
        case 'npm':
          return { exitCode: 1, stderr: 'boom' }
        default:
          return undefined // bun: not installed
      }
    })
    const info = await collectMachineInfo(exec, {
      homeDir: '/Users/test',
      platform: 'darwin',
      arch: 'arm64',
      userName: 'test',
    })
    expect(MachineInfo.parse(info)).toEqual(info)
    expect(info).toMatchObject({
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '15.6.1',
      machineLabel: null,
      homeDir: '/Users/test',
      userName: 'test',
    })
    expect(JSON.stringify(info)).not.toContain('hostname')
    const byId = new Map(info.tools.map((t) => [t.id, t]))
    expect(byId.get('node')).toMatchObject({ installed: true, version: 'v24.5.0' })
    expect(byId.get('claude')).toMatchObject({ installed: true, version: '2.1.247' })
    expect(byId.get('gh')?.version).toBe('gh version 2.80.0 (2026-01-01)')
    expect(byId.get('brew')?.version).toBe('Homebrew 5.0.0')
    expect(byId.get('git')?.version).toBe('git version 2.50.1')
    expect(byId.get('npm')).toMatchObject({ installed: false, version: null })
    expect(byId.get('bun')).toMatchObject({ installed: false, version: null })
    expect(info.tools.map((t) => t.id)).toEqual([
      'node',
      'pnpm',
      'npm',
      'bun',
      'git',
      'claude',
      'gh',
      'brew',
    ])
    for (const call of exec.calls) {
      expect(call.options.timeoutMs).toBe(10_000)
      expect(call.options.reject).toBe(false)
      expect(call.args.every((a) => a === '--version' || a === '-productVersion')).toBe(true)
    }
    expect(Date.parse(info.capturedAt)).not.toBeNaN()
  })

  it('never throws when every probe fails or throws unexpectedly', async () => {
    const exec = createFakeExec(() => {
      throw new Error('spawn EPERM')
    })
    const info = await collectMachineInfo(exec, {
      homeDir: '/h',
      platform: 'darwin',
      userName: 'u',
    })
    expect(info.osVersion).toBeNull()
    expect(info.tools.every((t) => !t.installed && t.version === null)).toBe(true)
  })

  it('uses os.release() on non-darwin platforms and falls back to env for the user name', async () => {
    const exec = createFakeExec(() => undefined)
    const info = await collectMachineInfo(exec, { homeDir: '/h', platform: 'linux' })
    expect(exec.calls.some((c) => c.file === 'sw_vers')).toBe(false)
    expect(typeof info.osVersion === 'string' || info.osVersion === null).toBe(true)
    expect(info.userName.length).toBeGreaterThan(0)
  })
})
