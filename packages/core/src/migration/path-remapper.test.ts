import path from 'node:path'
import type { ManifestProject, PathMapping } from '@devmig/model'
import { describe, expect, it } from 'vitest'
import {
  buildRemapReport,
  createPathMapper,
  deriveWorktreeMappings,
  isPrefixPath,
} from './path-remapper'

const HOME = '/Users/newuser'

describe('isPrefixPath', () => {
  it('is segment-boundary aware', () => {
    expect(isPrefixPath('/a/b', '/a/b')).toBe(true)
    expect(isPrefixPath('/a/b', '/a/b/c')).toBe(true)
    expect(isPrefixPath('/a/b', '/a/bc')).toBe(false)
    expect(isPrefixPath('/a/b', '/a')).toBe(false)
    expect(isPrefixPath('/', '/anything')).toBe(true)
  })
})

describe('createPathMapper', () => {
  const mappings: PathMapping[] = [
    { projectId: 'p1', oldPath: '/Users/olduser/Projects/app', newPath: '/Users/newuser/Code/app' },
  ]

  it('maps exact matches and children, leaving unrelated paths untouched', () => {
    const mapper = createPathMapper(mappings, { homeDir: HOME })
    expect(mapper.mapPath('/Users/olduser/Projects/app')).toEqual({
      newPath: '/Users/newuser/Code/app',
      changed: true,
      mapped: true,
    })
    expect(mapper.mapPath('/Users/olduser/Projects/app/src/index.ts')).toEqual({
      newPath: '/Users/newuser/Code/app/src/index.ts',
      changed: true,
      mapped: true,
    })
    expect(mapper.mapPath('/Users/olduser/Projects/app-other')).toEqual({
      newPath: '/Users/olduser/Projects/app-other',
      changed: false,
      mapped: false,
    })
    expect(mapper.mapPath('/Users/olduser/Projects')).toMatchObject({ mapped: false })
  })

  it('normalizes trailing slashes, dot segments, ~ and unicode (NFC) before comparing', () => {
    const mapper = createPathMapper(
      [{ projectId: 'p', oldPath: '~/Prójects/ünï/', newPath: '/dest/ünï/' }],
      { homeDir: '/Users/old' },
    )
    // The mapper expands ~ with its own homeDir, so an input in the same home matches.
    const decomposed = '/Users/old/Prójects/ünï/file.txt'
    expect(mapper.mapPath(decomposed)).toEqual({
      newPath: '/dest/ünï/file.txt'.normalize('NFC'),
      changed: true,
      mapped: true,
    })
    expect(mapper.mapPath('/Users/old/Prójects/ünï/./sub/../x')).toMatchObject({
      newPath: '/dest/ünï/x',
      mapped: true,
    })
    expect(mapper.mapPath('~/Prójects/ünï')).toMatchObject({ newPath: '/dest/ünï', mapped: true })
  })

  it('lets the longest (most specific) prefix win for nested mappings', () => {
    const mapper = createPathMapper(
      [
        { projectId: 'root', oldPath: '/old/mono', newPath: '/new/mono' },
        { projectId: 'pkg', oldPath: '/old/mono/packages/app', newPath: '/elsewhere/app' },
      ],
      { homeDir: HOME },
    )
    expect(mapper.mapPath('/old/mono/packages/app/src').newPath).toBe('/elsewhere/app/src')
    expect(mapper.mapPath('/old/mono/packages/lib/src').newPath).toBe('/new/mono/packages/lib/src')
    expect(mapper.mapPath('/old/mono').newPath).toBe('/new/mono')
  })

  it('reports mapped but unchanged for a no-op mapping (old == new)', () => {
    const mapper = createPathMapper([{ projectId: 'p', oldPath: '/same/x', newPath: '/same/x/' }], {
      homeDir: HOME,
    })
    expect(mapper.mapPath('/same/x/a')).toEqual({
      newPath: '/same/x/a',
      changed: false,
      mapped: true,
    })
  })

  it('ignores relative and empty inputs and rejects relative mapping entries', () => {
    const mapper = createPathMapper(mappings, { homeDir: HOME })
    expect(mapper.mapPath('')).toMatchObject({ mapped: false, changed: false })
    expect(mapper.mapPath('relative/path')).toMatchObject({
      mapped: false,
      newPath: 'relative/path',
    })
    expect(() =>
      createPathMapper([{ projectId: 'p', oldPath: 'rel', newPath: '/abs' }], { homeDir: HOME }),
    ).toThrow(/absolute/)
  })

  it('dedupes identical mappings and rejects conflicting ones', () => {
    const dup = createPathMapper([...mappings, { ...mappings[0]!, projectId: 'dup' }], {
      homeDir: HOME,
    })
    expect(dup.mappings).toHaveLength(1)
    expect(() =>
      createPathMapper(
        [...mappings, { projectId: 'x', oldPath: mappings[0]!.oldPath, newPath: '/other' }],
        { homeDir: HOME },
      ),
    ).toThrow(/Conflicting/)
  })
})

describe('deriveWorktreeMappings', () => {
  const project = (
    worktrees: ManifestProject['git'] extends infer G
      ? G extends { worktrees: infer W }
        ? W
        : never
      : never,
  ): ManifestProject => ({
    id: 'p1',
    name: 'app',
    originalPath: '/Users/olduser/Projects/app',
    canonicalPath: '/Users/olduser/Projects/app',
    git: {
      root: '/Users/olduser/Projects/app',
      remotes: [],
      head: 'abc',
      branch: 'main',
      detached: false,
      isLinkedWorktree: false,
      worktrees,
    },
    providers: [],
  })
  const mapping: PathMapping = {
    projectId: 'p1',
    oldPath: '/Users/olduser/Projects/app',
    newPath: '/Users/newuser/Code/app',
  }

  it('maps sibling worktrees via relativeToPrimary and skips worktrees inside the project', () => {
    const derived = deriveWorktreeMappings(
      project([
        {
          path: '/Users/olduser/Projects/app',
          branch: 'main',
          head: 'a',
          isPrimary: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/Users/olduser/Projects/app-feature',
          branch: 'feature',
          head: 'b',
          isPrimary: false,
          detached: false,
          locked: false,
          prunable: false,
          relativeToPrimary: '../app-feature',
        },
        {
          path: '/Users/olduser/Projects/app/.claude/worktrees/agent',
          branch: null,
          head: 'c',
          isPrimary: false,
          detached: true,
          locked: false,
          prunable: false,
          relativeToPrimary: '.claude/worktrees/agent',
        },
      ]),
      mapping,
      { homeDir: HOME },
    )
    expect(derived).toEqual([
      {
        projectId: 'p1',
        oldPath: '/Users/olduser/Projects/app-feature',
        newPath: '/Users/newuser/Code/app-feature',
      },
    ])
  })

  it('falls back to <new parent>/<basename> when no relative expression exists', () => {
    const derived = deriveWorktreeMappings(
      project([
        {
          path: '/Users/olduser/Projects/app',
          branch: 'main',
          head: 'a',
          isPrimary: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/Volumes/Ext/worktrees/app-hotfix',
          branch: 'hotfix',
          head: 'b',
          isPrimary: false,
          detached: false,
          locked: false,
          prunable: false,
        },
      ]),
      mapping,
      { homeDir: HOME },
    )
    expect(derived).toEqual([
      {
        projectId: 'p1',
        oldPath: '/Volumes/Ext/worktrees/app-hotfix',
        newPath: '/Users/newuser/Code/app-hotfix',
      },
    ])
  })

  it('handles a project that is itself a linked worktree (sibling primary)', () => {
    const linked: ManifestProject = {
      ...project([
        {
          path: '/Users/olduser/Projects/app',
          branch: 'main',
          head: 'a',
          isPrimary: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/Users/olduser/Projects/app-feature',
          branch: 'feature',
          head: 'b',
          isPrimary: false,
          detached: false,
          locked: false,
          prunable: false,
          relativeToPrimary: '../app-feature',
        },
      ]),
      canonicalPath: '/Users/olduser/Projects/app-feature',
    }
    const derived = deriveWorktreeMappings(
      linked,
      {
        projectId: 'p1',
        oldPath: '/Users/olduser/Projects/app-feature',
        newPath: '/Users/newuser/Code/app-feature',
      },
      { homeDir: HOME },
    )
    expect(derived).toEqual([
      {
        projectId: 'p1',
        oldPath: '/Users/olduser/Projects/app',
        newPath: '/Users/newuser/Code/app',
      },
    ])
  })

  it('returns nothing without git info, and with trailing slashes / ~ in the mapping', () => {
    expect(deriveWorktreeMappings({ ...project([]), git: undefined }, mapping)).toEqual([])
    const derived = deriveWorktreeMappings(
      project([
        {
          path: '/Users/olduser/Projects/app/',
          branch: 'main',
          head: 'a',
          isPrimary: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/Users/olduser/Projects/app-wt/',
          branch: 'x',
          head: 'b',
          isPrimary: false,
          detached: false,
          locked: false,
          prunable: false,
          relativeToPrimary: '../app-wt',
        },
      ]),
      { projectId: 'p1', oldPath: '/Users/olduser/Projects/app/', newPath: '~/Code/app/' },
      { homeDir: HOME },
    )
    expect(derived).toEqual([
      {
        projectId: 'p1',
        oldPath: '/Users/olduser/Projects/app-wt',
        newPath: path.join(HOME, 'Code', 'app-wt'),
      },
    ])
  })

  it('composes with createPathMapper so worktree children follow the derived mapping', () => {
    const derived = deriveWorktreeMappings(
      project([
        {
          path: '/Users/olduser/Projects/app',
          branch: 'main',
          head: 'a',
          isPrimary: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/Users/olduser/Projects/app-feature',
          branch: 'feature',
          head: 'b',
          isPrimary: false,
          detached: false,
          locked: false,
          prunable: false,
          relativeToPrimary: '../app-feature',
        },
      ]),
      mapping,
      { homeDir: HOME },
    )
    const mapper = createPathMapper([mapping, ...derived], { homeDir: HOME })
    expect(mapper.mapPath('/Users/olduser/Projects/app-feature/src/a.ts').newPath).toBe(
      '/Users/newuser/Code/app-feature/src/a.ts',
    )
    expect(mapper.mapPath('/Users/olduser/Projects/app/.claude/worktrees/agent/x').newPath).toBe(
      '/Users/newuser/Code/app/.claude/worktrees/agent/x',
    )
  })
})

describe('buildRemapReport', () => {
  it('merges provider sections and attributes them to providers', () => {
    const mappings: PathMapping[] = [{ projectId: 'p', oldPath: '/a', newPath: '/b' }]
    const report = buildRemapReport(
      [
        {
          providerId: 'claude-code',
          remap: {
            affected: [{ label: 'sessions', count: 3 }],
            safeRewriteCount: 12,
            warnings: ['w1'],
            unsupportedReferences: [{ location: 'x.jsonl:4', reason: 'unknown schema' }],
          },
        },
        {
          providerId: 'git',
          remap: {
            affected: [{ label: 'worktrees', count: 1 }],
            safeRewriteCount: 1,
            warnings: [],
            unsupportedReferences: [],
          },
        },
      ],
      mappings,
    )
    expect(report).toEqual({
      mappings,
      affected: [
        { providerId: 'claude-code', label: 'sessions', count: 3 },
        { providerId: 'git', label: 'worktrees', count: 1 },
      ],
      safeRewriteCount: 13,
      warnings: ['w1'],
      unsupportedReferences: [
        { providerId: 'claude-code', location: 'x.jsonl:4', reason: 'unknown schema' },
      ],
    })
  })
})
