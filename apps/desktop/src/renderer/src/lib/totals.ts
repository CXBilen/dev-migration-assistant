import type { ProviderScanResult, ScanSession, ScannedArtifact } from '@devmig/model'
import { isSessionsArtifact, isWorktreeArtifact, needsReview } from './artifacts'

export interface SelectionTotals {
  projects: number
  artifacts: number
  bytes: number
  sessions: number
  worktrees: number
  sensitiveIncluded: number
  weakMatchesIncluded: number
}

export function allArtifacts(scan: ScanSession): ScannedArtifact[] {
  const out: ScannedArtifact[] = []
  for (const p of scan.projects) for (const r of p.providers) out.push(...r.artifacts)
  for (const r of scan.global) out.push(...r.artifacts)
  return out
}

export function defaultSelectedIds(scan: ScanSession): Set<string> {
  const ids = new Set<string>()
  for (const a of allArtifacts(scan)) if (a.selectable && a.includedByDefault) ids.add(a.id)
  return ids
}

export interface SelectEverythingPlan {
  /** Every selectable artifact (ephemeral ones only when shown). Credentials are never selectable. */
  ids: Set<string>
  /** Sensitive artifacts that would be included — the user must acknowledge these first. */
  sensitive: ScannedArtifact[]
  /** Weak Claude Code matches that would be included. */
  weak: ScannedArtifact[]
}

/** "Select everything": all selectable artifacts, with the items worth a warning listed separately. */
export function selectEverything(scan: ScanSession, showEphemeral: boolean): SelectEverythingPlan {
  const plan: SelectEverythingPlan = { ids: new Set(), sensitive: [], weak: [] }
  for (const a of allArtifacts(scan)) {
    if (!a.selectable) continue
    if (a.scope === 'ephemeral' && !showEphemeral) continue
    plan.ids.add(a.id)
    if (a.sensitivity === 'sensitive') plan.sensitive.push(a)
    if (needsReview(a)) plan.weak.push(a)
  }
  return plan
}

export function computeTotals(scan: ScanSession, selected: ReadonlySet<string>): SelectionTotals {
  const totals: SelectionTotals = {
    projects: scan.projects.length,
    artifacts: 0,
    bytes: 0,
    sessions: 0,
    worktrees: 0,
    sensitiveIncluded: 0,
    weakMatchesIncluded: 0,
  }
  for (const a of allArtifacts(scan)) {
    if (!selected.has(a.id)) continue
    totals.artifacts += 1
    totals.bytes += a.sizeBytes ?? 0
    if (isSessionsArtifact(a)) totals.sessions += a.count ?? 0
    if (isWorktreeArtifact(a)) totals.worktrees += a.count ?? 0
    if (a.sensitivity === 'sensitive') totals.sensitiveIncluded += 1
    if (needsReview(a)) totals.weakMatchesIncluded += 1
  }
  return totals
}

export interface SecurityGroups {
  included: ScannedArtifact[]
  excluded: ScannedArtifact[]
  sensitive: ScannedArtifact[]
  credentials: ScannedArtifact[]
}

/** Partitions artifacts for the Security Review screen. Ephemeral items are hidden unless requested. */
export function groupForSecurityReview(
  scan: ScanSession,
  selected: ReadonlySet<string>,
  showEphemeral: boolean,
): SecurityGroups {
  const groups: SecurityGroups = { included: [], excluded: [], sensitive: [], credentials: [] }
  for (const a of allArtifacts(scan)) {
    if (a.sensitivity === 'credential') {
      groups.credentials.push(a)
      continue
    }
    if (a.scope === 'ephemeral' && !showEphemeral) continue
    if (a.sensitivity === 'sensitive' && a.selectable) {
      groups.sensitive.push(a)
      continue
    }
    if (selected.has(a.id)) groups.included.push(a)
    else groups.excluded.push(a)
  }
  return groups
}

export function providerResultsSorted<T extends ProviderScanResult>(
  results: T[],
  rank: (id: string) => number,
): T[] {
  return [...results].sort((a, b) => rank(a.providerId) - rank(b.providerId))
}
