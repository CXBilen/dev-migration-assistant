import { describe, expect, it } from 'vitest'
import { isMigrationError } from '@devmig/shared'
import { assertSafeArg, assertSafeBranchName, bindExecEnv, gitTestEnv } from './git-env'
import { createFakeExec } from './fake-exec'

describe('assertSafeArg', () => {
  it('accepts ordinary values and rejects empty, control characters and leading dashes', () => {
    expect(assertSafeArg('feature/x', 'branch')).toBe('feature/x')
    expect(assertSafeArg('/tmp/some path', 'path')).toBe('/tmp/some path')
    for (const bad of ['', '-rf', '--upload-pack=evil', 'a\nb', 'a\0b', 'a\rb']) {
      expect(() => assertSafeArg(bad, 'value')).toThrow()
    }
    try {
      assertSafeArg('-x', 'branch')
    } catch (e) {
      expect(isMigrationError(e) && e.code).toBe('INVALID_INPUT')
    }
  })
})

describe('assertSafeBranchName', () => {
  it.each(['main', 'feature/onboarding', 'worktree-onboarding', 'release/v1.2.3', 'a.b'])(
    'accepts %s',
    (name) => {
      expect(assertSafeBranchName(name)).toBe(name)
    },
  )
  it.each([
    'HEAD',
    '-bad',
    '/leading',
    'trailing/',
    'double//slash',
    'dot..dot',
    'at@{',
    'space here',
    'tilde~',
    'caret^',
    'colon:',
    'question?',
    'star*',
    'bracket[',
    'back\\slash',
    'x.lock',
    'x.lock/y',
    'ends.',
  ])('rejects %s', (name) => {
    expect(() => assertSafeBranchName(name)).toThrow()
  })
})

describe('gitTestEnv / bindExecEnv', () => {
  it('isolates git from global/system config and merges env into every call', async () => {
    const env = gitTestEnv('/tmp/fake-home')
    expect(env.HOME).toBe('/tmp/fake-home')
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    const fake = createFakeExec([{ match: () => true, result: {} }])
    const bound = bindExecEnv(fake.exec, env)
    await bound('git', ['status'], { env: { EXTRA: '1', HOME: '/override' } })
    expect(fake.calls[0]?.options?.env).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      EXTRA: '1',
      HOME: '/override',
    })
  })
})
