import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTempRoot, type TempRoot } from '../testing/engine-fixtures'
import {
  DEFAULT_CONTENT_SNIFF_BYTES,
  classifyContent,
  classifyFile,
  classifyJsonValue,
  classifyPath,
} from './secret-classifier'

describe('classifyPath', () => {
  it.each([
    ['id_rsa', 'credential'],
    ['/Users/me/.ssh/id_ed25519', 'credential'],
    ['id_rsa.pub', 'safe'],
    ['server.pem', 'credential'],
    ['tls.key', 'credential'],
    ['cert.p12', 'credential'],
    ['store.pfx', 'credential'],
    ['.netrc', 'credential'],
    ['credentials.json', 'credential'],
    ['login.keychain', 'credential'],
    ['/Users/me/.aws/credentials', 'credential'],
    ['.env', 'sensitive'],
    ['.env.local', 'sensitive'],
    ['.env.production', 'sensitive'],
    ['.env.example', 'safe'],
    ['.env.sample', 'safe'],
    ['.env.template', 'safe'],
    ['.env.dist', 'safe'],
    ['.envrc', 'sensitive'],
    ['db.secret', 'sensitive'],
    ['docker-compose.override.yml', 'sensitive'],
    ['.yarnrc.yml', 'sensitive'],
    ['.pypirc', 'sensitive'],
    ['.npmrc', 'sensitive'],
    ['github-token.json', 'sensitive'],
    ['client_secret.yaml', 'sensitive'],
    ['config.token.json', 'sensitive'],
    ['README.md', 'safe'],
    ['package.json', 'safe'],
    ['.nvmrc', 'safe'],
    ['src/tokenizer.ts', 'safe'],
    ['docker-compose.yml', 'safe'],
    ['.ssh/config', 'safe'],
    ['.ssh/known_hosts', 'safe'],
  ] as const)('%s → %s', (p, expected) => {
    const result = classifyPath(p)
    expect(result.sensitivity).toBe(expected)
    if (expected !== 'safe') expect(result.reasons.length).toBeGreaterThan(0)
    else expect(result.reasons).toEqual([])
  })

  it('is case-insensitive and ignores trailing slashes', () => {
    expect(classifyPath('SERVER.PEM').sensitivity).toBe('credential')
    expect(classifyPath('/x/.ENV/').sensitivity).toBe('sensitive')
  })
})

describe('classifyContent', () => {
  it.each([
    ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'sensitive'],
    ['token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'sensitive'],
    ['aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'sensitive'],
    [
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'sensitive',
    ],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----', 'credential'],
    ['//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789', 'credential'],
    ['DATABASE_URL=postgres://user:s3cretpass@db.example.com:5432/app', 'sensitive'],
    ['SLACK_TOKEN=xoxb-1234567890-abcdefghij', 'sensitive'],
    ['GOOGLE_KEY=AIzaSyA-abcdefghijklmnopqrstuvwxyz0123456', 'sensitive'],
  ] as const)('flags %s', (text, expected) => {
    const result = classifyContent(text)
    expect(result.sensitivity).toBe(expected)
    expect(result.matches).toBeGreaterThan(0)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it.each([
    'PORT=3000\nNODE_ENV=development\n',
    'API_KEY=${API_KEY}\nSECRET=<your-secret-here>\nPASSWORD=changeme\nTOKEN=xxxxxxxx',
    'const token = tokenize(input)\nexport function secretSanta() {}',
    '# README\nThis project uses tokens for auth. See docs.',
    'password: null\nsecret: true\napiKey: 123',
    '{"name":"app","version":"1.0.0","dependencies":{"jsonwebtoken":"^9.0.0"}}',
  ])('does not flag %s', (text) => {
    const result = classifyContent(text)
    expect(result.sensitivity).toBe('safe')
    expect(result.matches).toBe(0)
  })

  it('treats binary buffers as safe and only inspects the first maxBytes', () => {
    const binary = Buffer.concat([
      Buffer.from([0, 1, 2, 3]),
      Buffer.from('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    ])
    expect(classifyContent(binary)).toEqual({ sensitivity: 'safe', reasons: [], matches: 0 })
    const padded = 'x'.repeat(1000) + '\nTOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n'
    expect(classifyContent(padded, { maxBytes: 500 }).matches).toBe(0)
    expect(classifyContent(padded).matches).toBeGreaterThan(0)
    expect(DEFAULT_CONTENT_SNIFF_BYTES).toBe(256 * 1024)
  })
})

describe('classifyFile', () => {
  let tmp: TempRoot
  beforeAll(async () => {
    tmp = await makeTempRoot('devmig-classify-')
  })
  afterAll(async () => {
    await tmp.cleanup()
  })

  it('combines filename and content evidence', async () => {
    const env = path.join(tmp.root, '.env')
    await fs.writeFile(env, 'DB_PASSWORD=hunter2-really-long\n')
    const envResult = await classifyFile(env)
    expect(envResult.sensitivity).toBe('sensitive')
    expect(envResult.contentInspected).toBe(true)
    expect(envResult.reasons).toContain('Environment file')
    expect(envResult.matches).toBeGreaterThan(0)

    const npmrc = path.join(tmp.root, '.npmrc')
    await fs.writeFile(
      npmrc,
      '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789\n',
    )
    expect((await classifyFile(npmrc)).sensitivity).toBe('credential')

    const plain = path.join(tmp.root, 'notes.txt')
    await fs.writeFile(plain, 'hello world\n')
    expect(await classifyFile(plain)).toMatchObject({
      sensitivity: 'safe',
      matches: 0,
      contentInspected: true,
    })
  })

  it('skips content for large or binary files and missing files classify by name only', async () => {
    const big = path.join(tmp.root, 'big.txt')
    await fs.writeFile(big, 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(10))
    const result = await classifyFile(big, { maxBytes: 100 })
    expect(result.contentInspected).toBe(false)
    expect(result.sensitivity).toBe('safe')

    const bin = path.join(tmp.root, 'image.png')
    await fs.writeFile(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    expect((await classifyFile(bin)).contentInspected).toBe(false)

    const missing = await classifyFile(path.join(tmp.root, 'nope', 'id_rsa'))
    expect(missing).toMatchObject({ sensitivity: 'credential', contentInspected: false })
  })
})

describe('classifyJsonValue', () => {
  it('reports secret-looking keys, env/header blocks and token-shaped strings with json paths', () => {
    const hits = classifyJsonValue({
      mcpServers: {
        github: {
          command: 'npx',
          env: {
            GITHUB_TOKEN: 'ghp_x',
            HOME: '/Users/me',
            WEIRD: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
          },
          headers: { Authorization: 'Bearer abc' },
        },
      },
      oauthAccount: { emailAddress: 'me@example.com', accessToken: 'abc' },
      numChanges: 3,
      list: ['plain', 'AKIAIOSFODNN7EXAMPLE'],
    })
    const paths = hits.map((h) => h.path)
    expect(paths).toContain('mcpServers.github.env.GITHUB_TOKEN')
    expect(paths).toContain('mcpServers.github.env.WEIRD')
    expect(paths).toContain('mcpServers.github.headers.Authorization')
    expect(paths).toContain('oauthAccount.accessToken')
    expect(paths).toContain('list[1]')
    expect(paths).not.toContain('mcpServers.github.env.HOME')
    expect(paths).not.toContain('mcpServers.github.command')
    expect(paths).not.toContain('numChanges')
    expect(paths).not.toContain('oauthAccount.emailAddress')
  })

  it('returns nothing for benign values', () => {
    expect(
      classifyJsonValue({ theme: 'dark', projects: { '/Users/me/app': { allowedTools: [] } } }),
    ).toEqual([])
    expect(classifyJsonValue(null)).toEqual([])
    expect(classifyJsonValue(42)).toEqual([])
  })
})
