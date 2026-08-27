import { describe, expect, it } from 'vitest'
import { encodeClaudeProjectDir } from '@devmig/test-utils'
import { CLAUDE_PROJECT_DIR_MAX_LENGTH } from './constants'
import { encodeProjectDirName, verifyEncoding } from './encoding'

describe('encodeProjectDirName', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(encodeProjectDirName('/Users/alice/Documents/GitHub/demo')).toEqual({
      name: '-Users-alice-Documents-GitHub-demo',
      truncated: false,
    })
  })

  it('handles underscores, dots, spaces and worktree paths like the observed rule', () => {
    expect(encodeProjectDirName('/Users/alice/Desktop/CRO_Backup').name).toBe(
      '-Users-alice-Desktop-CRO-Backup',
    )
    expect(
      encodeProjectDirName('/Users/alice/Documents/GitHub/demo/.claude/worktrees/pcd-blockers')
        .name,
    ).toBe('-Users-alice-Documents-GitHub-demo--claude-worktrees-pcd-blockers')
    expect(encodeProjectDirName('/Users/alice/My Projects/app v2').name).toBe(
      '-Users-alice-My-Projects-app-v2',
    )
    expect(encodeProjectDirName('/private/var/folders/2_/41sndn6j4/T').name).toBe(
      '-private-var-folders-2--41sndn6j4-T',
    )
  })

  it('treats non-ASCII letters as non-alphanumeric (ASCII-only hypothesis)', () => {
    expect(encodeProjectDirName('/Users/zoë/Projekte/äpfel').name).toBe('-Users-zo--Projekte--pfel')
  })

  it('agrees with the test-utils fixture encoder for ordinary paths', () => {
    for (const p of [
      '/Users/alice/Documents/GitHub/demo',
      '/tmp/x_y.z',
      '/Users/bob/Developer/demo-onboarding',
    ]) {
      expect(encodeProjectDirName(p).name).toBe(encodeClaudeProjectDir(p))
    }
  })

  it('never guesses the hash suffix for names longer than 200 characters', () => {
    const long = `/Users/alice/${'a'.repeat(250)}`
    const encoded = encodeProjectDirName(long)
    expect(encoded.truncated).toBe(true)
    expect(encoded.name).toHaveLength(CLAUDE_PROJECT_DIR_MAX_LENGTH)
    expect(encoded.name.startsWith('-Users-alice-aaaa')).toBe(true)
  })
})

describe('verifyEncoding', () => {
  const dir = '/fake/.claude'

  it('verifies when every sampled directory reproduces its cwd', () => {
    const result = verifyEncoding(dir, [
      {
        dirName: '-Users-alice-Documents-GitHub-demo',
        cwds: ['/Users/alice/Documents/GitHub/demo'],
      },
      { dirName: '-Users-alice-Desktop-CRO-Backup', cwds: ['/Users/alice/Desktop/CRO_Backup'] },
    ])
    expect(result).toMatchObject({ verified: true, matched: 2, mismatched: 0, unknown: 0 })
    expect(result.examples[0]).toMatchObject({
      status: 'matched',
      cwd: '/Users/alice/Documents/GitHub/demo',
    })
  })

  it('accepts a directory when any of several cwds agrees (sessions can /cd)', () => {
    const result = verifyEncoding(dir, [
      { dirName: '-Users-alice-demo', cwds: ['/tmp/elsewhere', '/Users/alice/demo'] },
    ])
    expect(result.matched).toBe(1)
    expect(result.verified).toBe(true)
  })

  it('reports mismatches and does not verify', () => {
    const result = verifyEncoding(dir, [
      { dirName: '-Users-alice-demo', cwds: ['/Users/alice/demo'] },
      { dirName: 'some-other-scheme', cwds: ['/Users/alice/other'] },
    ])
    expect(result).toMatchObject({ verified: false, matched: 1, mismatched: 1 })
    expect(result.examples.find((e) => e.status === 'mismatched')).toMatchObject({
      dirName: 'some-other-scheme',
      expected: '-Users-alice-other',
    })
  })

  it('counts directories without cwd evidence or with 200+ char names as unknown', () => {
    const result = verifyEncoding(dir, [
      { dirName: '-Users-alice-empty', cwds: [] },
      { dirName: 'x'.repeat(200), cwds: ['/Users/alice/long'] },
    ])
    expect(result).toMatchObject({ verified: false, matched: 0, mismatched: 0, unknown: 2 })
  })
})
