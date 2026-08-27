import { describe, expect, it } from 'vitest'
import type { ProjectGitInfo, ScannedArtifact } from '@devmig/model'
import {
  bundleArtifactId,
  ignoredArtifactId,
  isJunkPath,
  parseSelection,
  pathDepth,
  slugForPath,
  untrackedSensitiveArtifactId,
  worktreeStateArtifactId,
  worktreesOf,
} from './common'

describe('worktreesOf', () => {
  it('puts the primary first even when the selected directory is a linked worktree', () => {
    const git: ProjectGitInfo = {
      root: '/p/demo-onboarding',
      remotes: [],
      head: 'a'.repeat(40),
      branch: 'feature/onboarding',
      detached: false,
      isLinkedWorktree: true,
      worktrees: [
        {
          path: '/p/demo-onboarding',
          branch: 'feature/onboarding',
          head: 'a'.repeat(40),
          isPrimary: false,
          detached: false,
          locked: false,
          prunable: false,
          relativeToPrimary: '../demo-onboarding',
        },
        {
          path: '/p/demo',
          branch: 'main',
          head: 'b'.repeat(40),
          isPrimary: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/p/demo/.claude/worktrees/x',
          branch: null,
          head: 'c'.repeat(40),
          isPrimary: false,
          detached: true,
          locked: false,
          prunable: false,
        },
      ],
    }
    const refs = worktreesOf(git)
    expect(refs.map((r) => [r.index, r.path, r.isPrimary, r.relativeToPrimary])).toEqual([
      [0, '/p/demo', true, undefined],
      [1, '/p/demo-onboarding', false, '../demo-onboarding'],
      [2, '/p/demo/.claude/worktrees/x', false, '.claude/worktrees/x'],
    ])
  })

  it('falls back to the root when no worktree information is available', () => {
    const git: ProjectGitInfo = {
      root: '/p/demo',
      remotes: [],
      head: null,
      branch: 'main',
      detached: false,
      isLinkedWorktree: false,
      worktrees: [],
    }
    expect(worktreesOf(git)).toEqual([
      {
        index: 0,
        path: '/p/demo',
        isPrimary: true,
        branch: 'main',
        head: null,
        detached: false,
        locked: false,
        prunable: false,
      },
    ])
  })
})

describe('junk classification and slugs', () => {
  it('recognises build/dependency/cache directories and log files', () => {
    for (const p of [
      'node_modules/',
      'dist/',
      'build',
      'out/',
      'coverage/',
      '.next/',
      '.cache/',
      '.turbo/',
      '.vite/',
      '.DS_Store',
      '__pycache__/',
      '.pytest_cache/',
      'target/',
      '.gradle/',
      'Pods/',
      'DerivedData/',
      'server.log',
      'logs/app.LOG',
    ]) {
      expect(isJunkPath(p), p).toBe(true)
    }
    for (const p of [
      '.env.local',
      'CLAUDE.local.md',
      '.claude/settings.local.json',
      'data/fixtures/',
      'notes.md',
    ]) {
      expect(isJunkPath(p), p).toBe(false)
    }
  })

  it('computes path depth ignoring trailing slashes', () => {
    expect(pathDepth('a')).toBe(1)
    expect(pathDepth('a/b/')).toBe(2)
    expect(pathDepth('a/b/c')).toBe(3)
  })

  it('produces stable, filesystem-safe, unique slugs', () => {
    const a = slugForPath('.env.local')
    expect(a).toMatch(/^env\.local-[0-9a-f]{8}$/)
    expect(slugForPath('.env.local')).toBe(a)
    expect(slugForPath('.claude/settings.local.json')).toMatch(
      /^claude-settings\.local\.json-[0-9a-f]{8}$/,
    )
    expect(slugForPath('weird name/with spaces')).toMatch(/^weird-name-with-spaces-[0-9a-f]{8}$/)
    expect(slugForPath('../escape')).not.toContain('..')
    expect(slugForPath('a')).toBe(slugForPath('a/'))
  })

  it('builds project-scoped artifact ids', () => {
    expect(bundleArtifactId('p1')).toBe('git:p1:bundle')
    expect(worktreeStateArtifactId('p1', 2)).toBe('git:p1:worktree:2:state')
    expect(untrackedSensitiveArtifactId('p1', 0)).toBe('git:p1:worktree:0:untracked-sensitive')
    expect(ignoredArtifactId('p1', 0, 'env-abc')).toBe('git:p1:worktree:0:ignored:env-abc')
  })
})

describe('parseSelection', () => {
  const base = (id: string, meta: Record<string, unknown>): ScannedArtifact => ({
    id,
    providerId: 'git',
    scope: 'project',
    kind: 'file',
    label: id,
    sensitivity: 'safe',
    includedByDefault: true,
    selectable: true,
    reasons: [],
    meta,
  })

  it('interprets typed meta and reports unknown artifacts', () => {
    const selection = parseSelection([
      base('git:p:bundle', {
        kind: 'bundle',
        primaryPath: '/p',
        repositoryJson: 'projects/p/git/repository.json',
      }),
      base('git:p:worktree:0:state', {
        kind: 'worktree-state',
        worktreeIndex: 0,
        path: '/p',
        isPrimary: true,
        branch: 'main',
        head: null,
        detached: false,
      }),
      base('git:p:worktree:1:untracked-sensitive', {
        kind: 'untracked-sensitive',
        worktreeIndex: 1,
        path: '/p-wt',
        paths: ['.env'],
      }),
      base('git:p:worktree:0:ignored:x', {
        kind: 'ignored',
        worktreeIndex: 0,
        path: '/p',
        relPath: '.env.local',
        isDirectory: false,
        slug: 'x',
      }),
      base('git:p:worktree:0:junk:y', { kind: 'junk', worktreeIndex: 0, relPath: 'node_modules' }),
      base('git:p:mystery', { kind: 'mystery' }),
    ])
    expect(selection.bundle).toBe(true)
    expect(selection.bundleArtifactId).toBe('git:p:bundle')
    expect([...selection.worktreeStates.entries()]).toEqual([[0, 'git:p:worktree:0:state']])
    expect([...selection.sensitive.keys()]).toEqual([1])
    expect(selection.ignored.map((i) => i.relPath)).toEqual(['.env.local'])
    expect(selection.repositoryJson).toBe('projects/p/git/repository.json')
    expect(selection.warnings).toHaveLength(2)
  })

  it('ignores unsafe repositoryJson locations', () => {
    const selection = parseSelection([
      base('git:p:bundle', {
        kind: 'bundle',
        primaryPath: '/p',
        repositoryJson: '../../etc/passwd',
      }),
    ])
    expect(selection.repositoryJson).toBeUndefined()
  })
})
