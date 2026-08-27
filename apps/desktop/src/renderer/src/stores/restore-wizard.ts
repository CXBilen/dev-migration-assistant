import type {
  BackupHeaderInfo,
  BackupInspection,
  CollisionPolicy,
  PathMapping,
  RestorePlan,
  RestoreResult,
} from '@devmig/model'
import { create } from 'zustand'

export interface RestoreWizardState {
  backupPath: string | null
  headerInfo: BackupHeaderInfo | null
  password: string
  inspection: BackupInspection | null
  mappings: PathMapping[]
  selectedArtifactIds: Set<string>
  includeGlobal: boolean
  planJobId: string | null
  plan: RestorePlan | null
  collisionDecisions: Record<string, CollisionPolicy>
  executeJobId: string | null
  result: RestoreResult | null

  setBackupPath: (path: string | null) => void
  setHeaderInfo: (info: BackupHeaderInfo | null) => void
  setPassword: (password: string) => void
  /** Stores the inspection and derives default mappings (restore to the previous path) and selection (everything). */
  setInspection: (inspection: BackupInspection | null) => void
  setMapping: (projectId: string, newPath: string) => void
  setArtifactSelected: (id: string, selected: boolean) => void
  setIncludeGlobal: (include: boolean) => void
  setPlanJob: (jobId: string | null) => void
  /** Stores the plan and seeds collision decisions with the plan defaults. */
  setPlan: (plan: RestorePlan | null) => void
  setCollisionDecision: (collisionId: string, policy: CollisionPolicy) => void
  setExecuteJob: (jobId: string | null) => void
  setResult: (result: RestoreResult | null) => void
  reset: () => void
}

const initial = {
  backupPath: null,
  headerInfo: null,
  password: '',
  inspection: null,
  mappings: [] as PathMapping[],
  selectedArtifactIds: new Set<string>(),
  includeGlobal: false,
  planJobId: null,
  plan: null,
  collisionDecisions: {} as Record<string, CollisionPolicy>,
  executeJobId: null,
  result: null,
}

export function projectArtifactIds(inspection: BackupInspection): string[] {
  const ids: string[] = []
  for (const p of inspection.manifest.projects)
    for (const s of p.providers) for (const a of s.artifacts) ids.push(a.id)
  return ids
}

export function globalArtifactIds(inspection: BackupInspection): string[] {
  const ids: string[] = []
  for (const s of inspection.manifest.global) for (const a of s.artifacts) ids.push(a.id)
  return ids
}

export const useRestoreWizard = create<RestoreWizardState>((set) => ({
  ...initial,
  setBackupPath: (backupPath) =>
    set({
      backupPath,
      headerInfo: null,
      inspection: null,
      plan: null,
      planJobId: null,
      result: null,
      executeJobId: null,
    }),
  setHeaderInfo: (headerInfo) => set({ headerInfo }),
  setPassword: (password) => set({ password }),
  setInspection: (inspection) =>
    set({
      inspection,
      mappings: inspection
        ? inspection.manifest.projects.map((p) => ({
            projectId: p.id,
            oldPath: p.canonicalPath,
            newPath: p.canonicalPath,
          }))
        : [],
      selectedArtifactIds: inspection ? new Set(projectArtifactIds(inspection)) : new Set<string>(),
      includeGlobal: false,
      plan: null,
      planJobId: null,
      collisionDecisions: {},
      executeJobId: null,
      result: null,
    }),
  setMapping: (projectId, newPath) =>
    set((s) => ({
      mappings: s.mappings.map((m) => (m.projectId === projectId ? { ...m, newPath } : m)),
    })),
  setArtifactSelected: (id, selected) =>
    set((s) => {
      if (s.selectedArtifactIds.has(id) === selected) return {}
      const next = new Set(s.selectedArtifactIds)
      if (selected) next.add(id)
      else next.delete(id)
      return { selectedArtifactIds: next }
    }),
  setIncludeGlobal: (includeGlobal) =>
    set((s) => {
      const next = new Set(s.selectedArtifactIds)
      const globalIds = s.inspection ? globalArtifactIds(s.inspection) : []
      for (const id of globalIds) {
        if (includeGlobal) next.add(id)
        else next.delete(id)
      }
      return { includeGlobal, selectedArtifactIds: next }
    }),
  setPlanJob: (planJobId) => set({ planJobId }),
  setPlan: (plan) =>
    set({
      plan,
      collisionDecisions: plan
        ? Object.fromEntries(
            [...plan.projects.flatMap((p) => p.collisions), ...plan.globalCollisions].map((c) => [
              c.id,
              c.policy,
            ]),
          )
        : {},
      executeJobId: null,
      result: null,
    }),
  setCollisionDecision: (collisionId, policy) =>
    set((s) => ({ collisionDecisions: { ...s.collisionDecisions, [collisionId]: policy } })),
  setExecuteJob: (executeJobId) => set({ executeJobId }),
  setResult: (result) => set({ result }),
  reset: () =>
    set({
      ...initial,
      mappings: [],
      selectedArtifactIds: new Set<string>(),
      collisionDecisions: {},
    }),
}))
