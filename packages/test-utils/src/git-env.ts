import path from 'node:path'
import type { Exec, ExecOptions, ExecResult } from '@devmig/shared'
import { MigrationError } from '@devmig/shared'

export const FIXTURE_GIT_USER = { name: 'Fixture User', email: 'fixture@example.com' } as const

/**
 * Environment that makes git fully deterministic and independent of the developer's real config:
 * no global/system config (no gpg signing, no templates, no global excludes), fixed identity,
 * C locale, no prompts. Spread it into every git call that touches fixture repositories.
 */
export function gitTestEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: FIXTURE_GIT_USER.name,
    GIT_AUTHOR_EMAIL: FIXTURE_GIT_USER.email,
    GIT_COMMITTER_NAME: FIXTURE_GIT_USER.name,
    GIT_COMMITTER_EMAIL: FIXTURE_GIT_USER.email,
    LC_ALL: 'C',
    LANG: 'C',
  }
}

/** Returns an Exec that merges `env` into every call (explicit per-call env still wins). */
export function bindExecEnv(exec: Exec, env: Record<string, string | undefined>): Exec {
  return (file, args, options = {}) =>
    exec(file, args, { ...options, env: { ...env, ...(options.env ?? {}) } })
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Validates a string that came from outside (branch name, path, URL, message) before it is placed
 * in an argv array: non-empty, no control characters (NUL, newline, ...), and never starting with
 * '-' (option injection).
 */
export function assertSafeArg(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MigrationError('INVALID_INPUT', `${label} must be a non-empty string`)
  }
  if (hasControlCharacters(value)) {
    throw new MigrationError('INVALID_INPUT', `${label} contains control characters`)
  }
  if (value.startsWith('-')) {
    throw new MigrationError('INVALID_INPUT', `${label} must not start with '-': ${value}`, {
      details: { label },
    })
  }
  return value
}

const BRANCH_FORBIDDEN_CHARS = /[\s~^:?*[\\]/

/**
 * Conservative branch-name check mirroring the rules of `git check-ref-format --branch` for the
 * shapes fixtures use: no leading/trailing '/', no '//', no '..', no '@{', no control characters,
 * no whitespace or ~^:?*[\ , no '.lock' component suffix, no trailing '.', not 'HEAD'.
 */
export function assertSafeBranchName(name: string): string {
  assertSafeArg(name, 'branch name')
  const invalid =
    name === 'HEAD' ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.includes('//') ||
    name.includes('..') ||
    name.includes('@{') ||
    BRANCH_FORBIDDEN_CHARS.test(name) ||
    name.split('/').some((component) => component === '' || component.endsWith('.lock'))
  if (invalid) {
    throw new MigrationError('GIT_INVALID_REF', `Invalid branch name: ${name}`)
  }
  return name
}

export type GitRunner = (
  args: readonly string[],
  cwd: string,
  options?: Omit<ExecOptions, 'cwd'>,
) => Promise<ExecResult>

/** Small helper that runs `git <args>` in `cwd` through the given Exec with the fixture env. */
export function createGitRunner(
  exec: Exec,
  env: Record<string, string | undefined>,
  defaults: Omit<ExecOptions, 'cwd' | 'env'> = {},
): GitRunner {
  return (args, cwd, options = {}) =>
    exec('git', args, { ...defaults, ...options, cwd, env: { ...env, ...(options.env ?? {}) } })
}
