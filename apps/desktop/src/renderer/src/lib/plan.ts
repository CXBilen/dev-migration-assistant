import type { BackupInspection, Collision, PreflightCheck, RestorePlan } from '@devmig/model'
import { isSessionsArtifact } from './artifacts'

export function collisionsOf(plan: RestorePlan): Collision[] {
  return [...plan.projects.flatMap((p) => p.collisions), ...plan.globalCollisions]
}

export function blockingFailures(plan: RestorePlan): PreflightCheck[] {
  return plan.preflight.filter((c) => c.blocking && c.status === 'fail')
}

/** Number of Claude Code sessions a backup holds for one project (from the manifest, no I/O). */
export function sessionsForProject(inspection: BackupInspection, projectId: string): number {
  const project = inspection.manifest.projects.find((p) => p.id === projectId)
  if (!project) return 0
  let n = 0
  for (const s of project.providers)
    for (const a of s.artifacts) if (isSessionsArtifact(a)) n += a.fileCount ?? 0
  return n
}
