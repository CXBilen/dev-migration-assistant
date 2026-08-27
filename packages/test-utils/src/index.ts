/**
 * @devmig/test-utils — fixture toolkit shared by every package's tests.
 * Everything here writes only under directories the caller passes in (temp roots); builders refuse
 * the real home directory and its sensitive subtrees (see assertSafeFixtureRoot).
 */
export * from './temp'
export * from './fake-home'
export * from './ids'
export * from './jsonl'
export * from './fake-exec'
export * from './git-env'
export * from './git-parsers'
export * from './git-state'
export * from './git-fixture'
export * from './claude-encoding'
export * from './claude-fixture'
export * from './machine-fixture'
