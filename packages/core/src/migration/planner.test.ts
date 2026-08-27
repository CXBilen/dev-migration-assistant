import type { ScanSession, ScannedArtifact } from '@devmig/model'
import { describe, expect, it } from 'vitest'
import { DefaultMigrationPlanner, defaultSelection } from './planner'

/** `expect.stringContaining` typed as string so it can sit inside typed matcher objects. */
const containing = (text: string): string => expect.stringContaining(text) as string

function artifact(id: string, over: Partial<ScannedArtifact> = {}): ScannedArtifact {
  return {
    id,
    providerId: id.split(':')[0] ?? 'x',
    scope: 'project',
    kind: 'file',
    label: id,
    sensitivity: 'safe',
    includedByDefault: true,
    selectable: true,
    reasons: [],
    meta: {},
    sizeBytes: 10,
    ...over,
  }
}

function scan(): ScanSession {
  return {
    id: 'scan_1',
    createdAt: new Date().toISOString(),
    projects: [
      {
        project: {
          id: 'p1',
          name: 'one',
          originalPath: '/p1',
          canonicalPath: '/p1',
          realPath: '/p1',
          detectedProviders: ['git', 'files'],
        },
        providers: [
          {
            providerId: 'git',
            projectId: 'p1',
            detected: true,
            artifacts: [
              artifact('git:p1:bundle', { sizeBytes: 100 }),
              artifact('git:p1:ignored', {
                sensitivity: 'sensitive',
                includedByDefault: false,
                sizeBytes: 5,
              }),
            ],
            summary: [],
            warnings: [],
            estimatedBytes: 105,
          },
          {
            providerId: 'files',
            projectId: 'p1',
            detected: true,
            artifacts: [
              artifact('files:p1:env', {
                sensitivity: 'sensitive',
                includedByDefault: false,
                sizeBytes: 3,
              }),
              artifact('files:p1:lock', {
                scope: 'ephemeral',
                selectable: false,
                includedByDefault: false,
              }),
            ],
            summary: [],
            warnings: [],
            estimatedBytes: 3,
          },
        ],
        estimatedBytes: 108,
        warnings: [],
      },
      {
        project: {
          id: 'p2',
          name: 'two',
          originalPath: '/p2',
          canonicalPath: '/p2',
          realPath: '/p2',
          detectedProviders: [],
        },
        providers: [
          {
            providerId: 'git',
            projectId: 'p2',
            detected: false,
            artifacts: [],
            summary: [],
            warnings: [],
            estimatedBytes: 0,
          },
        ],
        estimatedBytes: 0,
        warnings: [],
      },
    ],
    global: [
      {
        providerId: 'claude-code',
        detected: true,
        artifacts: [
          artifact('claude-code:settings', { scope: 'user', sizeBytes: 7 }),
          artifact('claude-code:credentials', {
            scope: 'user',
            sensitivity: 'credential',
            includedByDefault: false,
            selectable: false,
          }),
        ],
        summary: [],
        warnings: [],
        estimatedBytes: 7,
      },
    ],
    warnings: [],
  }
}

describe('defaultSelection', () => {
  it('selects includedByDefault + selectable + non-credential artifacts only', () => {
    expect(defaultSelection(scan()).sort()).toEqual(['claude-code:settings', 'git:p1:bundle'])
  })
})

describe('DefaultMigrationPlanner.buildBackupPlan', () => {
  const planner = new DefaultMigrationPlanner()

  it('groups selected artifacts by project and provider and sums bytes', () => {
    const plan = planner.buildBackupPlan(scan(), [
      'git:p1:bundle',
      'files:p1:env',
      'claude-code:settings',
      'git:p1:bundle', // duplicate selection is fine
    ])
    expect(plan.projects).toHaveLength(1)
    expect(plan.projects[0]?.project.id).toBe('p1')
    expect([...plan.projects[0]!.providers.keys()].sort()).toEqual(['files', 'git'])
    expect(plan.projects[0]!.providers.get('git')?.map((a) => a.id)).toEqual(['git:p1:bundle'])
    expect(plan.global.get('claude-code')?.map((a) => a.id)).toEqual(['claude-code:settings'])
    expect(plan.estimatedBytes).toBe(100 + 3 + 7)
    expect(plan.includedSensitive.map((a) => a.id)).toEqual(['files:p1:env'])
    expect(plan.warnings.some((w) => w.includes('"two" has no selected items'))).toBe(true)
    expect(plan.warnings.some((w) => w.includes('1 sensitive item'))).toBe(true)
  })

  it('rejects unknown ids, credentials and unselectable items with INVALID_INPUT', () => {
    expect(() => planner.buildBackupPlan(scan(), ['nope'])).toThrow(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: containing('Unknown artifact'),
      }),
    )
    expect(() => planner.buildBackupPlan(scan(), ['claude-code:credentials'])).toThrow(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: containing('Credentials'),
      }),
    )
    expect(() => planner.buildBackupPlan(scan(), ['files:p1:lock'])).toThrow(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: containing('transparency'),
      }),
    )
    expect(() => planner.buildBackupPlan(scan(), [])).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })
})
