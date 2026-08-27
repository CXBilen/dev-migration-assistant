import type { Collision } from '@devmig/model'
import { describe, expect, it } from 'vitest'
import {
  chooseDefaultPolicy,
  normalizeCollisions,
  resolveCollisionDecisions,
  unitKeyFor,
} from './collisions'

function collision(over: Partial<Collision> = {}): Collision {
  return {
    id: 'c1',
    providerId: 'files',
    kind: 'file-exists',
    path: '/dest/a',
    detail: 'exists',
    allowedPolicies: ['skip', 'backup-then-replace'],
    policy: 'skip',
    ...over,
  }
}

describe('chooseDefaultPolicy', () => {
  it('never downgrades a provider default of merge', () => {
    expect(
      chooseDefaultPolicy({ allowedPolicies: ['merge', 'skip'], policy: 'merge' }, 'skip'),
    ).toBe('merge')
    expect(
      chooseDefaultPolicy(
        { allowedPolicies: ['merge', 'skip', 'backup-then-replace'], policy: 'merge' },
        'backup-then-replace',
      ),
    ).toBe('merge')
  })
  it('applies the requested default when the provider allows it', () => {
    expect(
      chooseDefaultPolicy(
        { allowedPolicies: ['skip', 'backup-then-replace'], policy: 'skip' },
        'backup-then-replace',
      ),
    ).toBe('backup-then-replace')
    expect(
      chooseDefaultPolicy(
        { allowedPolicies: ['skip', 'backup-then-replace'], policy: 'backup-then-replace' },
        'skip',
      ),
    ).toBe('skip')
  })
  it('falls back to the provider default, then the first allowed policy', () => {
    expect(
      chooseDefaultPolicy({ allowedPolicies: ['alternate-path', 'skip'], policy: 'skip' }, 'merge'),
    ).toBe('skip')
    expect(
      chooseDefaultPolicy({ allowedPolicies: ['alternate-path'], policy: 'merge' }, 'skip'),
    ).toBe('alternate-path')
  })
})

describe('normalizeCollisions / resolveCollisionDecisions', () => {
  it('namespaces ids per unit, dedupes clashes and attributes provider/project', () => {
    const seen = new Set<string>()
    const a = normalizeCollisions(
      'files',
      'p1',
      [collision(), collision({ id: 'files:already' })],
      'skip',
      seen,
    )
    const b = normalizeCollisions('files', 'p2', [collision()], 'skip', seen)
    const c = normalizeCollisions('files', 'p2', [collision()], 'skip', seen)
    expect(a.map((x) => x.collision.id)).toEqual(['files@p1:c1', 'files:already'])
    expect(b[0]?.collision.id).toBe('files@p2:c1')
    expect(c[0]?.collision.id).toBe('files@p2:c1#2')
    expect(a[0]?.collision).toMatchObject({ providerId: 'files', projectId: 'p1', policy: 'skip' })
    expect(a[0]?.unitKey).toBe(unitKeyFor('files', 'p1'))
    expect(a[0]?.originalId).toBe('c1')
  })

  it('rejects collisions without any allowed policy', () => {
    expect(() =>
      normalizeCollisions(
        'files',
        undefined,
        [collision({ allowedPolicies: [] })],
        'skip',
        new Set(),
      ),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_FAILED' }))
  })

  it('validates decisions and hands them back keyed by the provider ids per unit', () => {
    const seen = new Set<string>()
    const norm = [
      ...normalizeCollisions('files', 'p1', [collision(), collision({ id: 'c2' })], 'skip', seen),
      ...normalizeCollisions(
        'globalcfg',
        undefined,
        [collision({ id: 'g', allowedPolicies: ['merge', 'skip'], policy: 'merge' })],
        'skip',
        seen,
      ),
    ]
    const resolved = resolveCollisionDecisions(norm, { 'files@p1:c1': 'backup-then-replace' })
    expect(resolved.get('files@p1')).toEqual({ c1: 'backup-then-replace', c2: 'skip' })
    expect(resolved.get('globalcfg@global')).toEqual({ g: 'merge' })
    expect(() => resolveCollisionDecisions(norm, { unknown: 'skip' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
    expect(() => resolveCollisionDecisions(norm, { 'files@p1:c1': 'merge' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })
})
