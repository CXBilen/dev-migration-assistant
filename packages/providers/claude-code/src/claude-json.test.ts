import { describe, expect, it } from 'vitest'
import {
  applyMcpEnv,
  assertNoIdentityKeys,
  extractProjectEntries,
  extractUserScope,
  findMcpSecretHits,
  findProjectEntryKey,
  mergeAddOnly,
  stripMcpSecrets,
} from './claude-json'

/** `expect.stringContaining` typed as string so it can sit inside typed matcher objects. */
const containing = (text: string): string => expect.stringContaining(text) as string

const json = {
  numStartups: 5,
  userID: 'u-fake',
  machineID: 'm-fake',
  oauthAccount: { accountUuid: 'fake' },
  diffTool: 'auto',
  autoConnectIde: false,
  mcpServers: {
    global: { type: 'http', url: 'https://example.com', headers: { Authorization: 'Bearer abc' } },
    plain: { type: 'stdio', command: 'x' },
  },
  projects: {
    '/Users/alice/demo': {
      allowedTools: ['Bash(git:*)'],
      hasTrustDialogAccepted: true,
      mcpServers: {
        demo: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'demo'],
          env: { DEMO_TOKEN: 'tok_secret_123' },
        },
      },
    },
    '/Users/alice/demo/.claude/worktrees/x': { allowedTools: [] },
    '/Users/alice/other': { allowedTools: ['Read'] },
  },
}

describe('stripMcpSecrets', () => {
  it('moves env/headers into a separate map and keeps the rest', () => {
    const r = stripMcpSecrets(json.mcpServers)
    expect(r.servers).toEqual({
      global: { type: 'http', url: 'https://example.com' },
      plain: { type: 'stdio', command: 'x' },
    })
    expect(r.secrets).toEqual({ global: { headers: { Authorization: 'Bearer abc' } } })
  })
})

describe('extractProjectEntries', () => {
  it('extracts only the requested paths with MCP env stripped', () => {
    const r = extractProjectEntries(json, [
      '/Users/alice/demo',
      '/Users/alice/demo/.claude/worktrees/x',
      '/Users/alice/missing',
    ])
    expect(Object.keys(r.projects)).toEqual([
      '/Users/alice/demo',
      '/Users/alice/demo/.claude/worktrees/x',
    ])
    expect(r.projects['/Users/alice/demo']).toEqual({
      allowedTools: ['Bash(git:*)'],
      hasTrustDialogAccepted: true,
      mcpServers: { demo: { type: 'stdio', command: 'npx', args: ['-y', 'demo'] } },
    })
    expect(r.mcpEnv).toEqual({
      '/Users/alice/demo': { demo: { env: { DEMO_TOKEN: 'tok_secret_123' } } },
    })
    expect(JSON.stringify(r.projects)).not.toContain('tok_secret_123')
  })

  it('matches keys after canonicalization (trailing slash)', () => {
    expect(findProjectEntryKey(json.projects, '/Users/alice/demo/')).toBe('/Users/alice/demo')
    expect(findProjectEntryKey(json.projects, '/Users/alice/nope')).toBeUndefined()
  })
})

describe('extractUserScope', () => {
  it('returns stripped user servers, their secrets and only the global config keys', () => {
    const r = extractUserScope(json)
    expect(r.mcpServers).toEqual({
      global: { type: 'http', url: 'https://example.com' },
      plain: { type: 'stdio', command: 'x' },
    })
    expect(r.mcpEnv).toEqual({ global: { headers: { Authorization: 'Bearer abc' } } })
    expect(r.config).toEqual({ diffTool: 'auto', autoConnectIde: false })
    expect(r.config).not.toHaveProperty('userID')
    expect(r.config).not.toHaveProperty('oauthAccount')
  })
})

describe('mergeAddOnly / applyMcpEnv / assertNoIdentityKeys', () => {
  it('adds missing keys recursively and keeps existing values and arrays', () => {
    const target = { a: 1, nested: { x: 1, list: [1] }, list: ['keep'] }
    const r = mergeAddOnly(target, {
      a: 2,
      b: 3,
      nested: { x: 9, y: 2, list: [2, 3] },
      list: ['new'],
    })
    expect(target).toEqual({ a: 1, b: 3, nested: { x: 1, y: 2, list: [1] }, list: ['keep'] })
    expect(r.added).toEqual(['b', 'nested.y'])
    expect(r.kept).toEqual(['a', 'nested.x', 'nested.list', 'list'])
  })

  it('re-attaches env/headers add-only', () => {
    const servers: Record<string, unknown> = {
      demo: { command: 'npx', env: { EXISTING: '1' } },
      other: { command: 'y' },
    }
    const r = applyMcpEnv(servers, {
      demo: { env: { EXISTING: 'override', NEW: '2' }, headers: { H: 'v' } },
      missing: { env: { A: '1' } },
    })
    expect(r.applied).toEqual(['demo'])
    expect(servers.demo).toEqual({
      command: 'npx',
      env: { EXISTING: '1', NEW: '2' },
      headers: { H: 'v' },
    })
    expect(servers.other).toEqual({ command: 'y' })
  })

  it('refuses identity keys', () => {
    expect(() => assertNoIdentityKeys({ oauthAccount: {} }, 'x')).toThrow(/oauthAccount/)
    expect(() => assertNoIdentityKeys({ userID: 'u' }, 'x')).toThrow(/userID/)
    expect(() => assertNoIdentityKeys({ machineID: 'm' }, 'x')).toThrow(/machineID/)
    expect(() => assertNoIdentityKeys({ allowedTools: [] }, 'x')).not.toThrow()
  })
})

describe('findMcpSecretHits', () => {
  it('flags secret-looking values in args and urls but not env/headers (handled separately) or placeholders', () => {
    const hits = findMcpSecretHits({
      magic: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@21st-dev/magic@latest', 'API_KEY=21st_sk_abcdefghijklmnop'],
      },
      creds: { type: 'http', url: 'https://alice:hunter2pass@mcp.example.com/mcp' },
      clean: {
        type: 'stdio',
        command: 'uvx',
        args: ['server', '--token=${MY_TOKEN}', '--api-key'],
      },
      plain: { type: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=abc' },
    })
    expect(hits.map((h) => h.server).sort()).toEqual(['creds', 'magic'])
    expect(hits.find((h) => h.server === 'magic')).toMatchObject({
      path: 'args[2]',
      reason: containing('Secret-looking'),
    })
    expect(hits.find((h) => h.server === 'creds')?.reason).toContain(
      'URL with embedded credentials',
    )
    expect(JSON.stringify(hits)).not.toContain('21st_sk_')
    expect(JSON.stringify(hits)).not.toContain('hunter2pass')
  })
})
