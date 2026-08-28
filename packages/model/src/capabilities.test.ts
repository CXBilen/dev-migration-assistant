import { describe, expect, it } from 'vitest'
import { CapabilitySnapshot, IntegrationRecord } from './capabilities'
import { Diagnostics } from './diagnostics'
import { RestorePhase } from './jobs'
import { Manifest } from './manifest'
import { Remediation } from './remediation'

const snapshot = {
  schemaVersion: 1,
  capturedAt: '2026-08-28T10:00:00.000Z',
  role: 'source',
  search: { paths: ['/opt/homebrew/bin', '/usr/bin'] },
  tools: [
    {
      id: 'gh',
      label: 'GitHub CLI',
      installed: true,
      version: '2.96.0',
      path: '/opt/homebrew/bin/gh',
      installMethod: 'homebrew',
    },
    { id: 'bun', label: 'Bun', installed: false, version: null, path: null, installMethod: null },
  ],
  integrations: [
    {
      id: 'github-cli',
      recipeId: 'github-cli',
      kind: 'cli-auth',
      name: 'GitHub CLI',
      scope: 'machine',
      requiresSignIn: true,
      sourceSignIn: 'signed-in',
    },
    {
      id: 'mcp:project:p1:supabase',
      recipeId: 'claude-code',
      kind: 'mcp-server',
      name: 'supabase',
      scope: 'project',
      projectId: 'p1',
      transport: 'http',
      url: 'https://mcp.supabase.com/mcp',
      requiresSignIn: true,
    },
  ],
  plugins: [
    { id: 'vercel', marketplace: 'claude-plugins-official', version: '0.45.1', enabled: true },
  ],
  marketplaces: [
    {
      name: 'claude-plugins-official',
      source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
    },
  ],
  claude: {
    version: '2.1.250',
    installMethod: 'native',
    transcriptWriterVersions: ['2.1.247', '2.1.250'],
  },
}

describe('CapabilitySnapshot', () => {
  it('parses a full snapshot and applies defaults for the optional collections', () => {
    const parsed = CapabilitySnapshot.parse(snapshot)
    expect(parsed.integrations[1]?.sourceSignIn).toBe('unknown')
    const minimal = CapabilitySnapshot.parse({
      ...snapshot,
      integrations: undefined,
      plugins: undefined,
      marketplaces: undefined,
    })
    expect(minimal.integrations).toEqual([])
    expect(minimal.plugins).toEqual([])
    expect(minimal.marketplaces).toEqual([])
  })

  it('uses field names the redactor leaves alone', () => {
    const keys = new Set<string>()
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object')
        for (const [k, c] of Object.entries(v)) {
          keys.add(k)
          walk(c)
        }
    }
    walk(CapabilitySnapshot.parse(snapshot))
    for (const k of keys) expect(k).not.toMatch(/auth|token|secret|credential|oauth/i)
  })

  it('rejects an unknown integration kind', () => {
    expect(
      IntegrationRecord.safeParse({ ...snapshot.integrations[0], kind: 'magic' }).success,
    ).toBe(false)
  })
})

const base = {
  format: 'devbackup',
  formatVersion: 1,
  id: 'b1',
  label: 'x',
  createdAt: '2026-08-28T10:00:00.000Z',
  appVersion: '0.2.0',
  machine: {
    platform: 'darwin',
    arch: 'arm64',
    osVersion: null,
    machineLabel: null,
    homeDir: '/h',
    userName: 'u',
    tools: [],
    capturedAt: '2026-08-28T10:00:00.000Z',
  },
  providers: {},
  projects: [],
  global: [],
  stats: { projectCount: 0, artifactCount: 0, payloadBytes: 0 },
  restoreHints: {},
}

describe('additive model changes', () => {
  it('Manifest accepts an optional capabilities field and still parses without it', () => {
    expect(Manifest.parse(base).capabilities).toBeUndefined()
    expect(Manifest.parse({ ...base, capabilities: snapshot }).capabilities?.role).toBe('source')
  })

  it('Diagnostics.searchPaths defaults to [] and RestorePhase knows RESTORE_RUNTIME', () => {
    expect(Diagnostics.shape.searchPaths.parse(undefined)).toEqual([])
    expect(RestorePhase.options).toContain('RESTORE_RUNTIME')
  })

  it('Remediation keeps the v0.1 shape and accepts the new optional action metadata', () => {
    expect(
      Remediation.parse({
        id: 'gh-auth-login',
        title: 'Sign in',
        command: ['gh', 'auth', 'login'],
      }),
    ).toMatchObject({ id: 'gh-auth-login' })
    expect(
      Remediation.parse({ id: 'x', title: 'y', cwd: '/p', network: true, interactive: true })
        .interactive,
    ).toBe(true)
  })
})

describe('a backup written by a newer app still restores', () => {
  it('degrades a newer capability snapshot to "not captured" instead of failing the manifest', () => {
    const parsed = Manifest.safeParse({
      ...base,
      capabilities: { ...snapshot, schemaVersion: 2, futureField: { anything: true } },
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.capabilities).toBeUndefined()
    // Everything restorable is untouched.
    expect(parsed.data?.formatVersion).toBe(1)
    expect(parsed.data?.id).toBe('b1')
  })

  it('degrades a snapshot carrying an install method this reader does not know', () => {
    const parsed = Manifest.safeParse({
      ...base,
      capabilities: {
        ...snapshot,
        tools: [{ ...snapshot.tools[0], installMethod: 'nix-profile' }],
      },
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.capabilities).toBeUndefined()
  })

  it('keeps the rest of machine.tools when one entry has an unknown install method', () => {
    const parsed = Manifest.parse({
      ...base,
      machine: {
        ...base.machine,
        tools: [
          {
            id: 'claude',
            label: 'Claude Code',
            version: '2.1.250',
            path: '/usr/local/bin/claude',
            installMethod: 'nix-profile',
            installed: true,
          },
        ],
      },
    })
    expect(parsed.machine.tools[0]?.installMethod).toBeUndefined()
    expect(parsed.machine.tools[0]?.version).toBe('2.1.250')
  })

  it('still parses a snapshot this reader does understand, and still rejects a broken manifest', () => {
    expect(Manifest.parse({ ...base, capabilities: snapshot }).capabilities?.schemaVersion).toBe(1)
    expect(Manifest.safeParse({ ...base, stats: undefined }).success).toBe(false)
  })
})
