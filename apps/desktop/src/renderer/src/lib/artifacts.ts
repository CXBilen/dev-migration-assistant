import type { ManifestArtifact, ScannedArtifact } from '@devmig/model'

/**
 * Presentation heuristics over artifacts. Providers own their artifacts' semantics; the UI
 * only needs to answer "is this the sessions artifact?" for totals and copy. Providers can
 * make this exact by setting `meta.category` to 'sessions' | 'worktrees'.
 */
type AnyArtifact = Pick<ScannedArtifact, 'providerId' | 'label' | 'meta'> | ManifestArtifact

function category(a: AnyArtifact): string | undefined {
  const c = a.meta['category']
  return typeof c === 'string' ? c : undefined
}

export function isSessionsArtifact(a: AnyArtifact): boolean {
  if (a.providerId !== 'claude-code') return false
  const c = category(a)
  if (c) return c === 'sessions'
  return /session/i.test(a.label)
}

export function isWorktreeArtifact(a: AnyArtifact): boolean {
  if (a.providerId !== 'git') return false
  const c = category(a)
  if (c) return c === 'worktrees'
  return /worktree/i.test(a.label)
}

/** Claude project matches with `weak` confidence are surfaced with a "needs review" badge. */
export function needsReview(a: ScannedArtifact): boolean {
  const confidence = a.meta['confidence'] ?? a.meta['matchConfidence']
  return confidence === 'weak'
}

export function artifactCount(a: ScannedArtifact): number {
  return a.count ?? 0
}

export const PROVIDER_ORDER = ['git', 'claude-code', 'project-files', 'runtime'] as const

export const PROVIDER_LABELS: Record<string, string> = {
  git: 'Git',
  'claude-code': 'Claude Code',
  'project-files': 'Project files',
  runtime: 'Runtime',
}

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id
}

export function providerRank(id: string): number {
  const idx = (PROVIDER_ORDER as readonly string[]).indexOf(id)
  return idx === -1 ? PROVIDER_ORDER.length : idx
}
