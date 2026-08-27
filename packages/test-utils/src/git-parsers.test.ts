import { describe, expect, it } from 'vitest'
import {
  parseStatusV2,
  parseWorktreeListPorcelain,
  relativeWorktreeShape,
  splitLines,
  splitNul,
  statusEntryPath,
} from './git-parsers'

describe('parseWorktreeListPorcelain', () => {
  it('parses main, linked, detached, bare, locked and prunable entries', () => {
    const text = [
      'worktree /tmp/demo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /tmp/demo-onboarding',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/onboarding',
      'locked reason with spaces',
      '',
      'worktree /tmp/demo-detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /tmp/bare.git',
      'bare',
      '',
      'worktree /tmp/unborn',
      'HEAD 0000000000000000000000000000000000000000',
      'branch refs/heads/main',
      '',
    ].join('\n')
    const entries = parseWorktreeListPorcelain(text)
    expect(entries).toHaveLength(5)
    expect(entries[0]).toEqual({
      path: '/tmp/demo',
      head: '1111111111111111111111111111111111111111',
      branch: 'main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    })
    expect(entries[1]).toMatchObject({
      path: '/tmp/demo-onboarding',
      branch: 'feature/onboarding',
      locked: true,
      lockReason: 'reason with spaces',
    })
    expect(entries[2]).toMatchObject({
      path: '/tmp/demo-detached',
      branch: null,
      detached: true,
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    })
    expect(entries[3]).toMatchObject({
      path: '/tmp/bare.git',
      bare: true,
      head: null,
      branch: null,
    })
    expect(entries[4]).toMatchObject({ path: '/tmp/unborn', head: null, branch: 'main' })
  })

  it('returns an empty list for empty output and tolerates CRLF / missing trailing blank line', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([])
    const entries = parseWorktreeListPorcelain('worktree /x\r\nHEAD abc\r\nbranch refs/heads/dev')
    expect(entries).toEqual([
      {
        path: '/x',
        head: 'abc',
        branch: 'dev',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ])
  })
})

describe('parseStatusV2', () => {
  it('parses changed, renamed, unmerged, untracked, ignored and header lines', () => {
    const lines = [
      '# branch.oid abc',
      '1 M. N... 100644 100644 100644 aaaa bbbb src/index.ts',
      '1 A. N... 000000 100644 100644 0000 cccc src/new-staged.ts',
      '1 .M N... 100644 100644 100644 dddd dddd README.md',
      '2 R. N... 100644 100644 100644 eeee eeee R100 new name.txt\told name.txt',
      'u UU N... 100644 100644 100644 100644 1111 2222 3333 conflict.txt',
      '? notes/todo.md',
      '! .env.local',
      'garbage',
    ]
    const entries = parseStatusV2(lines)
    expect(entries[0]).toEqual({ kind: 'header', key: 'branch.oid', value: 'abc' })
    expect(entries[1]).toMatchObject({
      kind: 'changed',
      xy: 'M.',
      path: 'src/index.ts',
      staged: true,
      unstaged: false,
      hashHead: 'aaaa',
      hashIndex: 'bbbb',
      modeHead: '100644',
    })
    expect(entries[2]).toMatchObject({
      kind: 'changed',
      xy: 'A.',
      path: 'src/new-staged.ts',
      staged: true,
    })
    expect(entries[3]).toMatchObject({
      kind: 'changed',
      xy: '.M',
      path: 'README.md',
      staged: false,
      unstaged: true,
    })
    expect(entries[4]).toMatchObject({
      kind: 'renamed',
      score: 'R100',
      path: 'new name.txt',
      originalPath: 'old name.txt',
      staged: true,
    })
    expect(entries[5]).toMatchObject({
      kind: 'unmerged',
      xy: 'UU',
      path: 'conflict.txt',
      hashStage1: '1111',
      hashStage3: '3333',
    })
    expect(entries[6]).toEqual({ kind: 'untracked', path: 'notes/todo.md' })
    expect(entries[7]).toEqual({ kind: 'ignored', path: '.env.local' })
    expect(entries[8]).toEqual({ kind: 'unknown', line: 'garbage' })
    expect(entries.map(statusEntryPath)).toEqual([
      null,
      'src/index.ts',
      'src/new-staged.ts',
      'README.md',
      'new name.txt',
      'conflict.txt',
      'notes/todo.md',
      '.env.local',
      null,
    ])
  })
})

describe('split helpers', () => {
  it('splitLines drops empty lines and CR; splitNul drops empty segments', () => {
    expect(splitLines('a\r\n\nb\n')).toEqual(['a', 'b'])
    expect(splitNul('a\0b\0\0')).toEqual(['a', 'b'])
  })

  it('relativeWorktreeShape yields the ../sibling form', () => {
    expect(relativeWorktreeShape('/tmp/x/demo', '/tmp/x/demo-onboarding')).toBe(
      '../demo-onboarding',
    )
    expect(relativeWorktreeShape('/tmp/x/demo', '/tmp/x/demo/.claude/worktrees/a')).toBe(
      '.claude/worktrees/a',
    )
  })
})
