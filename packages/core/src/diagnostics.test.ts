import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Diagnostics } from '@devmig/model'
import { ProviderRegistry } from './providers/registry'
import { collectDiagnostics } from './diagnostics'
import { createFakeExec } from './testing/fake-exec'
import {
  createFileProvider,
  createGlobalProvider,
  makeTempRoot,
  makeTestEnv,
  type TempRoot,
} from './testing/engine-fixtures'

describe('collectDiagnostics', () => {
  let tmp: TempRoot
  beforeEach(async () => {
    tmp = await makeTempRoot('devmig-diag-')
  })
  afterEach(async () => {
    await tmp.cleanup()
  })

  it('reports machine info, provider availability and Claude config dir facts without secrets', async () => {
    const exec = createFakeExec((file) =>
      file === 'claude' ? { stdout: '2.1.0 (Claude Code)\n' } : undefined,
    )
    const { env, claudeConfigDir } = await makeTestEnv(tmp.root, { exec })
    const broken = createFileProvider({ id: 'broken' })
    broken.detect = () => Promise.reject(new Error('detect exploded'))
    const registry = new ProviderRegistry()
      .register(createFileProvider())
      .register(createGlobalProvider())
      .register(broken)
    const diagnostics = await collectDiagnostics(
      env,
      registry,
      { appVersion: '1.2.3', electronVersion: null, logsDirectory: '/logs' },
      { nodeVersion: '24.0.0' },
    )
    expect(Diagnostics.parse(diagnostics)).toEqual(diagnostics)
    expect(diagnostics).toMatchObject({
      appVersion: '1.2.3',
      backupFormatVersion: 1,
      electronVersion: null,
      nodeVersion: '24.0.0',
      claudeConfigDir,
      claudeConfigDirExists: true,
      claudeCodeVersion: '2.1.0',
      logsDirectory: '/logs',
    })
    expect(diagnostics.machine.machineLabel).toBeNull()
    expect(diagnostics.providers.map((p) => [p.id, p.available])).toEqual([
      ['files', true],
      ['globalcfg', true],
      ['broken', false],
    ])
    expect(diagnostics.providers[2]?.notes[0]).toContain('detect exploded')

    await fs.rm(claudeConfigDir, { recursive: true, force: true })
    const again = await collectDiagnostics(env, registry, {
      appVersion: '1',
      electronVersion: '44',
      logsDirectory: '/l',
    })
    expect(again.claudeConfigDirExists).toBe(false)
    expect(again.electronVersion).toBe('44')
  })
})
