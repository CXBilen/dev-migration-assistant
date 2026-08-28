import { describe, expect, it } from 'vitest'
import { noopLogger } from '@devmig/shared'
import { createEnvironment } from './environment'
import type { SearchPathIo } from './search-path'
import { createFakeExec } from './testing/fake-exec'

const HOME = '/Users/alice'
const io: SearchPathIo = {
  isDirectory: (p) => ['/usr/bin', '/bin', '/opt/homebrew/bin', `${HOME}/.local/bin`].includes(p),
  isExecutableFile: () => false,
  readTextFile: () => null,
  listDirectory: () => [],
  realPath: (p) => p,
}

describe('createEnvironment', () => {
  it('augments PATH with the existing well-known directories and keeps the base order first', () => {
    const env = createEnvironment({
      logger: noopLogger,
      homeDir: HOME,
      env: { PATH: '/usr/bin:/bin', HOME },
      exec: createFakeExec(() => ({ stdout: '' })),
      searchPathIo: io,
    })
    expect(env.env.PATH).toBe(`/usr/bin:/bin:/opt/homebrew/bin:${HOME}/.local/bin`)
    expect(env.env.HOME).toBe(HOME)
  })

  it('forwards its env (with the augmented PATH) to every exec call, under per-call overrides', async () => {
    const fake = createFakeExec(() => ({ stdout: '' }))
    const env = createEnvironment({
      logger: noopLogger,
      homeDir: HOME,
      env: { PATH: '/usr/bin', HOME },
      exec: fake,
      searchPathIo: io,
    })
    await env.exec('git', ['--version'], { env: { GIT_TERMINAL_PROMPT: '0' } })
    await env.exec('git', ['--version'])
    expect(fake.calls[0]?.options.env).toMatchObject({
      PATH: `/usr/bin:/opt/homebrew/bin:${HOME}/.local/bin`,
      HOME,
      GIT_TERMINAL_PROMPT: '0',
    })
    expect(fake.calls[1]?.options.env?.PATH).toBe(`/usr/bin:/opt/homebrew/bin:${HOME}/.local/bin`)
  })

  it('leaves PATH untouched when augmentSearchPath is false', () => {
    const env = createEnvironment({
      logger: noopLogger,
      homeDir: HOME,
      env: { PATH: '/only' },
      exec: createFakeExec(() => ({ stdout: '' })),
      searchPathIo: io,
      augmentSearchPath: false,
    })
    expect(env.env.PATH).toBe('/only')
  })

  it('derives the Claude config dir and ~/.claude.json path as before', () => {
    const env = createEnvironment({
      logger: noopLogger,
      homeDir: HOME,
      env: { PATH: '', CLAUDE_CONFIG_DIR: '/tmp/cc' },
      exec: createFakeExec(() => ({ stdout: '' })),
      searchPathIo: io,
    })
    expect(env.claudeConfigDir).toBe('/tmp/cc')
    expect(env.claudeJsonPath).toBe('/tmp/cc/.claude.json')
  })
})
