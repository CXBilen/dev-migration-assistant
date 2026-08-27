import { describe, expect, it } from 'vitest'
import { encodeClaudeProjectDir } from './claude-encoding'

describe('encodeClaudeProjectDir', () => {
  it.each([
    ['/Users/alice/Documents/GitHub/looplift', '-Users-alice-Documents-GitHub-looplift'],
    ['/Users/alice/Desktop/CRO_Backup', '-Users-alice-Desktop-CRO-Backup'],
    [
      '/Users/alice/Documents/GitHub/looplift/.claude/worktrees/pcd-blockers',
      '-Users-alice-Documents-GitHub-looplift--claude-worktrees-pcd-blockers',
    ],
    ['/private/var/folders/2_/41sndn6j4/T', '-private-var-folders-2--41sndn6j4-T'],
    ['/tmp/a b/c.d', '-tmp-a-b-c-d'],
  ])('encodes %s -> %s (documented examples)', (input, expected) => {
    expect(encodeClaudeProjectDir(input)).toBe(expected)
  })

  it('preserves case and never truncates', () => {
    const long = `/x/${'a'.repeat(300)}`
    expect(encodeClaudeProjectDir(long)).toBe(`-x-${'a'.repeat(300)}`)
    expect(encodeClaudeProjectDir('/Users/Alice')).toBe('-Users-Alice')
  })
})
