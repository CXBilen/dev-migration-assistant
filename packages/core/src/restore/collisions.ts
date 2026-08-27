/**
 * Collision bookkeeping for restore plans (ADR-0008). Providers report collisions with their own ids;
 * the engine makes ids unique across the plan, applies the default policy the user asked for when the
 * provider allows it, and later validates the user's per-collision decisions.
 */
import type { Collision, CollisionPolicy } from '@devmig/model'
import { MigrationError } from '@devmig/shared'

export interface NormalizedCollision {
  /** Collision as shown in the plan (unique id across the plan, effective default policy). */
  collision: Collision
  /** The id the provider used; decisions are handed back to the provider under this id. */
  originalId: string
  /** `${providerId}@${projectId ?? 'global'}` */
  unitKey: string
}

export function unitKeyFor(providerId: string, projectId: string | undefined): string {
  return `${providerId}@${projectId ?? 'global'}`
}

/**
 * Picks the effective default policy for a collision the user has not decided individually:
 * 1. a provider default of `merge` (deterministic, add-only, non-destructive) is never downgraded;
 * 2. otherwise the requested engine-wide default when the provider allows it;
 * 3. otherwise the provider's own default when allowed, else the first allowed policy.
 */
export function chooseDefaultPolicy(
  collision: Pick<Collision, 'allowedPolicies' | 'policy'>,
  requestedDefault: CollisionPolicy,
): CollisionPolicy {
  const providerDefault = collision.allowedPolicies.includes(collision.policy)
    ? collision.policy
    : undefined
  if (providerDefault === 'merge') return 'merge'
  if (collision.allowedPolicies.includes(requestedDefault)) return requestedDefault
  return providerDefault ?? collision.allowedPolicies[0] ?? 'skip'
}

export function normalizeCollisions(
  providerId: string,
  projectId: string | undefined,
  collisions: Collision[],
  requestedDefault: CollisionPolicy,
  seenIds: Set<string>,
): NormalizedCollision[] {
  const unitKey = unitKeyFor(providerId, projectId)
  const out: NormalizedCollision[] = []
  for (const raw of collisions) {
    if (raw.allowedPolicies.length === 0) {
      throw new MigrationError(
        'PROVIDER_FAILED',
        `Provider "${providerId}" reported a collision without any allowed policy: ${raw.path}`,
        { details: { providerId, projectId, collisionId: raw.id } },
      )
    }
    const base = raw.id.startsWith(`${providerId}:`) ? raw.id : `${unitKey}:${raw.id}`
    let id = base
    let n = 2
    while (seenIds.has(id)) {
      id = `${base}#${n}`
      n += 1
    }
    seenIds.add(id)
    const collision: Collision = {
      ...raw,
      id,
      providerId,
      ...(projectId ? { projectId } : {}),
      policy: chooseDefaultPolicy(raw, requestedDefault),
    }
    out.push({ collision, originalId: raw.id, unitKey })
  }
  return out
}

/**
 * Validates the user's decisions and returns, per unit, the effective policy for every collision keyed by
 * the provider's original collision id.
 */
export function resolveCollisionDecisions(
  collisions: readonly NormalizedCollision[],
  decisions: Record<string, CollisionPolicy>,
): Map<string, Record<string, CollisionPolicy>> {
  const byId = new Map(collisions.map((c) => [c.collision.id, c]))
  for (const [id, policy] of Object.entries(decisions)) {
    const entry = byId.get(id)
    if (!entry) {
      throw new MigrationError('INVALID_INPUT', `Unknown collision id in decisions: ${id}`, {
        details: { collisionId: id },
      })
    }
    if (!entry.collision.allowedPolicies.includes(policy)) {
      throw new MigrationError(
        'INVALID_INPUT',
        `Policy "${policy}" is not allowed for collision ${id} (allowed: ${entry.collision.allowedPolicies.join(', ')})`,
        { details: { collisionId: id, policy, allowed: entry.collision.allowedPolicies } },
      )
    }
  }
  const result = new Map<string, Record<string, CollisionPolicy>>()
  for (const entry of collisions) {
    const policy = decisions[entry.collision.id] ?? entry.collision.policy
    const unit = result.get(entry.unitKey) ?? {}
    unit[entry.originalId] = policy
    result.set(entry.unitKey, unit)
  }
  return result
}
