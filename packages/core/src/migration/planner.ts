/**
 * DefaultMigrationPlanner: turns a scan session + the user's artifact selection into a BackupPlan.
 * Pure function of its inputs; no I/O.
 */
import type { ProjectDescriptor, ScanSession, ScannedArtifact } from '@devmig/model'
import { MigrationError } from '@devmig/shared'
import type { BackupPlan, BackupPlanProjectEntry, MigrationPlanner } from '../api'

interface IndexedArtifact {
  artifact: ScannedArtifact
  projectId: string | undefined
  providerId: string
}

function indexArtifacts(scan: ScanSession): Map<string, IndexedArtifact> {
  const index = new Map<string, IndexedArtifact>()
  for (const project of scan.projects) {
    for (const provider of project.providers) {
      for (const artifact of provider.artifacts) {
        index.set(artifact.id, {
          artifact,
          projectId: project.project.id,
          providerId: provider.providerId,
        })
      }
    }
  }
  for (const provider of scan.global) {
    for (const artifact of provider.artifacts) {
      index.set(artifact.id, { artifact, projectId: undefined, providerId: provider.providerId })
    }
  }
  return index
}

/** Ids of artifacts a fresh backup wizard should pre-select. */
export function defaultSelection(scan: ScanSession): string[] {
  const ids: string[] = []
  for (const { artifact } of indexArtifacts(scan).values()) {
    if (
      artifact.includedByDefault &&
      artifact.selectable &&
      artifact.sensitivity !== 'credential'
    ) {
      ids.push(artifact.id)
    }
  }
  return ids
}

export class DefaultMigrationPlanner implements MigrationPlanner {
  buildBackupPlan(scan: ScanSession, selectedArtifactIds: string[]): BackupPlan {
    const index = indexArtifacts(scan)
    const unique = [...new Set(selectedArtifactIds)]
    if (unique.length === 0) {
      throw new MigrationError('INVALID_INPUT', 'Select at least one item to back up.', {
        hint: 'Nothing was selected.',
      })
    }

    const unknown: string[] = []
    const unselectable: string[] = []
    const credentials: string[] = []
    const selected: IndexedArtifact[] = []
    for (const id of unique) {
      const entry = index.get(id)
      if (!entry) {
        unknown.push(id)
        continue
      }
      if (entry.artifact.sensitivity === 'credential') {
        credentials.push(id)
        continue
      }
      if (!entry.artifact.selectable) {
        unselectable.push(id)
        continue
      }
      selected.push(entry)
    }
    if (unknown.length > 0) {
      throw new MigrationError(
        'INVALID_INPUT',
        `Unknown artifact id(s): ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`,
        { details: { unknown, scanId: scan.id } },
      )
    }
    if (credentials.length > 0) {
      throw new MigrationError(
        'INVALID_INPUT',
        'Credentials (OAuth tokens, session keys) can never be included in a backup. Re-authenticate on the destination machine instead.',
        { details: { credentials }, hint: 'Deselect the credential items and try again.' },
      )
    }
    if (unselectable.length > 0) {
      throw new MigrationError(
        'INVALID_INPUT',
        `These items are shown for transparency only and cannot be backed up: ${unselectable.join(', ')}`,
        { details: { unselectable } },
      )
    }

    const warnings: string[] = []
    const projectEntries = new Map<string, BackupPlanProjectEntry>()
    const global = new Map<string, ScannedArtifact[]>()
    const includedSensitive: ScannedArtifact[] = []
    let estimatedBytes = 0

    const projectById = new Map<string, ProjectDescriptor>()
    for (const p of scan.projects) projectById.set(p.project.id, p.project)

    for (const { artifact, projectId, providerId } of selected) {
      estimatedBytes += artifact.sizeBytes ?? 0
      if (artifact.sensitivity !== 'safe') includedSensitive.push(artifact)
      if (projectId) {
        const project = projectById.get(projectId)
        if (!project) continue
        let entry = projectEntries.get(projectId)
        if (!entry) {
          entry = { project, providers: new Map() }
          projectEntries.set(projectId, entry)
        }
        const list = entry.providers.get(providerId) ?? []
        list.push(artifact)
        entry.providers.set(providerId, list)
      } else {
        const list = global.get(providerId) ?? []
        list.push(artifact)
        global.set(providerId, list)
      }
    }

    // Preserve scan order for projects.
    const projects: BackupPlanProjectEntry[] = []
    for (const p of scan.projects) {
      const entry = projectEntries.get(p.project.id)
      if (entry) projects.push(entry)
      else warnings.push(`"${p.project.name}" has no selected items and will not be included.`)
    }

    if (includedSensitive.length > 0) {
      warnings.push(
        `${includedSensitive.length} sensitive item(s) will be included: ${includedSensitive
          .map((a) => a.label)
          .slice(0, 5)
          .join(
            ', ',
          )}${includedSensitive.length > 5 ? '…' : ''}. They stay encrypted inside the backup.`,
      )
    }

    return { scan, projects, global, includedSensitive, estimatedBytes, warnings }
  }
}
