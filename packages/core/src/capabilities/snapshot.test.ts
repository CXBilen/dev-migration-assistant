import { CapabilitySnapshot, type MachineInfo } from '@devmig/model'
import { noopLogger } from '@devmig/shared'
import { describe, expect, it } from 'vitest'
import type { Environment } from '../environment'
import { createFakeExec } from '../testing/fake-exec'
import { collectCapabilitySnapshot, toolCapabilitiesOf } from './snapshot'

const machine: MachineInfo = {
  platform: 'darwin',
  arch: 'arm64',
  osVersion: '26.6',
  machineLabel: null,
  homeDir: '/Users/alice',
  userName: 'alice',
  capturedAt: '2026-08-28T10:00:00.000Z',
  tools: [
    {
      id: 'claude',
      label: 'Claude Code',
      version: '2.1.250',
      path: '/Users/alice/.local/bin/claude',
      installed: true,
      installMethod: 'native',
    },
    {
      id: 'gh',
      label: 'GitHub CLI',
      version: 'gh version 2.96.0 (2026-07-02)',
      path: '/opt/homebrew/bin/gh',
      installed: true,
      installMethod: 'homebrew',
    },
    { id: 'bun', label: 'Bun', version: null, path: null, installed: false },
  ],
}

function env(exec = createFakeExec(() => undefined)): Environment {
  return {
    homeDir: '/Users/alice',
    claudeConfigDir: '/Users/alice/.claude',
    claudeJsonPath: '/Users/alice/.claude.json',
    env: { PATH: '/opt/homebrew/bin:/Users/alice/.local/bin:/usr/bin' },
    exec,
    logger: noopLogger,
  }
}

describe('collectCapabilitySnapshot', () => {
  it('builds a source snapshot from an existing MachineInfo without probing again', async () => {
    const exec = createFakeExec(() => undefined)
    const snap = await collectCapabilitySnapshot(env(exec), {
      role: 'source',
      machine,
      transcriptWriterVersions: ['2.1.247', '2.1.250', '2.1.247'],
      now: () => new Date('2026-08-28T11:00:00.000Z'),
    })
    expect(exec.calls).toHaveLength(0)
    expect(CapabilitySnapshot.parse(snap)).toEqual(snap)
    expect(snap).toMatchObject({
      schemaVersion: 1,
      role: 'source',
      capturedAt: '2026-08-28T11:00:00.000Z',
      search: { paths: ['/opt/homebrew/bin', '/Users/alice/.local/bin', '/usr/bin'] },
      claude: {
        version: '2.1.250',
        installMethod: 'native',
        transcriptWriterVersions: ['2.1.247', '2.1.250'],
      },
      integrations: [],
      plugins: [],
      marketplaces: [],
    })
    expect(toolCapabilitiesOf(machine)).toEqual([
      {
        id: 'claude',
        label: 'Claude Code',
        installed: true,
        version: '2.1.250',
        path: '/Users/alice/.local/bin/claude',
        installMethod: 'native',
      },
      {
        id: 'gh',
        label: 'GitHub CLI',
        installed: true,
        version: '2.96.0',
        path: '/opt/homebrew/bin/gh',
        installMethod: 'homebrew',
      },
      { id: 'bun', label: 'Bun', installed: false, version: null, path: null, installMethod: null },
    ])
  })

  it('probes the machine when no MachineInfo is supplied and reports a missing Claude Code as null', async () => {
    const exec = createFakeExec((file) => (file === 'sw_vers' ? { stdout: '26.6\n' } : undefined))
    const snap = await collectCapabilitySnapshot(env(exec), { role: 'destination' })
    expect(exec.calls.some((c) => c.file === 'claude')).toBe(true)
    expect(snap.claude).toEqual({
      version: null,
      installMethod: null,
      transcriptWriterVersions: [],
    })
    expect(snap.tools.every((t) => !t.installed)).toBe(true)
  })

  it('contains no secret-looking keys', async () => {
    const snap = await collectCapabilitySnapshot(env(), { role: 'source', machine })
    expect(JSON.stringify(snap)).not.toMatch(/"(auth|token|secret|credential|oauth)[A-Za-z]*":/i)
  })
})
