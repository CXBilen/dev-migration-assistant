/**
 * "Move aside" destinations for the `backup-then-replace` collision policy (ADR-0008).
 *
 * A provider that replaces an existing destination first renames it to `<path>.devmig-backup-<timestamp>`.
 * For a top-level destination that name is a SIBLING of the approved root, which ScopedFs would reject.
 * Providers therefore announce the aside paths they intend to create in their plan `state`
 * (`asidePaths: string[]` and/or `backupAsidePath: string`, at any nesting level). The engine adds them to
 * the ScopedFs roots — but only when a collision of that unit was actually decided as `backup-then-replace`,
 * and only when the path really is a sibling aside of an approved root (or already inside one).
 */
import path from 'node:path'
import type { CollisionPolicy } from '@devmig/model'
import { canonicalizePath, isPathWithin } from '@devmig/shared'

export const ASIDE_INFIX = '.devmig-backup'
const MAX_DEPTH = 8

/** Collects every `asidePaths` entry and `backupAsidePath` value found in a provider plan state. */
export function collectAsidePaths(state: unknown): string[] {
  const out: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'asidePaths' && Array.isArray(child)) {
        for (const p of child) if (typeof p === 'string' && p.trim() !== '') out.push(p)
      } else if (key === 'backupAsidePath' && typeof child === 'string' && child.trim() !== '') {
        out.push(child)
      } else {
        visit(child, depth + 1)
      }
    }
  }
  visit(state, 0)
  return [...new Set(out)]
}

/** True when `candidate` is `<root>.devmig-backup…` next to `root`. */
export function isAsideOf(root: string, candidate: string): boolean {
  const r = canonicalizePath(root)
  const c = canonicalizePath(candidate)
  if (path.dirname(r) !== path.dirname(c)) return false
  return path.basename(c).startsWith(`${path.basename(r)}${ASIDE_INFIX}`)
}

export interface AsideRootsResult {
  /** Aside paths that may be added to the ScopedFs roots. */
  approved: string[]
  /** Candidates that were neither inside a root nor a sibling aside of one. */
  rejected: string[]
}

/**
 * Filters the aside candidates of a unit against its approved roots. Nothing is approved unless at
 * least one collision decision of the unit is `backup-then-replace`.
 */
export function approveAsideRoots(
  roots: readonly string[],
  candidates: readonly string[],
  decisions: Record<string, CollisionPolicy>,
): AsideRootsResult {
  const wantsAside = Object.values(decisions).includes('backup-then-replace')
  if (!wantsAside || candidates.length === 0) return { approved: [], rejected: [] }
  const approved: string[] = []
  const rejected: string[] = []
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      rejected.push(candidate)
      continue
    }
    const canonical = canonicalizePath(candidate)
    const ok = roots.some((root) => isPathWithin(root, canonical) || isAsideOf(root, canonical))
    if (ok) approved.push(canonical)
    else rejected.push(candidate)
  }
  return { approved: [...new Set(approved)], rejected }
}
