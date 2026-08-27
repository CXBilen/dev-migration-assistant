import { describe, expect, it } from 'vitest'
import { compareGitState, splitDiffByFile, type GitStateSnapshot } from './git-state'

function snapshot(overrides: Partial<GitStateSnapshot> = {}): GitStateSnapshot {
  return {
    repoPath: '/Users/alice/Documents/GitHub/demo',
    head: 'abc',
    branch: 'main',
    detached: false,
    statusV2: ['1 .M N... 100644 100644 100644 d d README.md', '? notes/todo.md'],
    stagedDiff: '',
    unstagedDiff: [
      'diff --git a/README.md b/README.md',
      'index d..e 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1,2 @@',
      ' # demo',
      '+note',
    ].join('\n'),
    untracked: ['notes/todo.md'],
    worktrees: [
      {
        path: '/Users/alice/Documents/GitHub/demo',
        head: 'abc',
        branch: 'main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/Users/alice/Documents/GitHub/demo-onboarding',
        head: 'def',
        branch: 'feature/onboarding',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    ...overrides,
  }
}

describe('compareGitState', () => {
  it('treats a snapshot as equal to itself and to a relocated copy (different absolute paths)', () => {
    const a = snapshot()
    expect(compareGitState(a, a)).toEqual({ equal: true, differences: [] })
    const relocated = snapshot({
      repoPath: '/Users/bob/Projects/demo',
      worktrees: [
        {
          path: '/Users/bob/Projects/demo',
          head: 'abc',
          branch: 'main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/Users/bob/Projects/demo-onboarding',
          head: 'def',
          branch: 'feature/onboarding',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
    })
    expect(compareGitState(a, relocated).equal).toBe(true)
  })

  it('reports head, branch, detached, status, untracked, diff and worktree-shape differences', () => {
    const a = snapshot()
    const b = snapshot({
      head: 'zzz',
      branch: null,
      detached: true,
      statusV2: ['? notes/todo.md', '? extra.txt'],
      untracked: ['notes/todo.md', 'extra.txt'],
      unstagedDiff: '',
      stagedDiff: 'diff --git a/x b/x\n',
      worktrees: [
        {
          path: '/Users/alice/Documents/GitHub/demo',
          head: 'zzz',
          branch: null,
          detached: true,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
    })
    const result = compareGitState(a, b)
    expect(result.equal).toBe(false)
    expect(result.differences).toEqual(
      expect.arrayContaining([
        'head: abc != zzz',
        'branch: main != null',
        'detached: false != true',
        expect.stringContaining('statusV2: only in first'),
        expect.stringContaining('statusV2: only in second: ? extra.txt'),
        'untracked: only in second: extra.txt',
        'stagedDiff differs',
        'unstagedDiff differs',
        expect.stringContaining('worktrees: only in first: ../demo-onboarding'),
      ]),
    )
  })

  it('ignorePaths removes files and directory prefixes from status, untracked and diffs', () => {
    const a = snapshot()
    const b = snapshot({
      statusV2: [
        ...a.statusV2,
        '? .claude/settings.local.json',
        '1 .M N... 100644 100644 100644 a b src/index.ts',
      ],
      untracked: [...a.untracked, '.claude/settings.local.json'],
      unstagedDiff: `${a.unstagedDiff}\ndiff --git a/src/index.ts b/src/index.ts\nindex a..b 100644\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-x\n+y`,
    })
    expect(compareGitState(a, b).equal).toBe(false)
    expect(compareGitState(a, b, { ignorePaths: ['.claude', 'src/index.ts'] }).equal).toBe(true)
    expect(compareGitState(a, b, { ignorePaths: ['.claude/'] }).equal).toBe(false)
  })
})

describe('splitDiffByFile', () => {
  it('splits a multi-file diff and keys blocks by the b/ path', () => {
    const diff = ['diff --git a/a.txt b/a.txt', '+a', 'diff --git a/b.txt b/b.txt', '+b'].join('\n')
    expect(splitDiffByFile(diff)).toEqual([
      { path: 'a.txt', text: 'diff --git a/a.txt b/a.txt\n+a' },
      { path: 'b.txt', text: 'diff --git a/b.txt b/b.txt\n+b' },
    ])
    expect(splitDiffByFile('')).toEqual([])
  })
})
