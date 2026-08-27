import type { BackupResult, ScanSession } from '@devmig/model'
import { create } from 'zustand'
import { defaultSelectedIds } from '../lib/totals'

export interface BackupWizardState {
  selectedPaths: string[]
  scanJobId: string | null
  scan: ScanSession | null
  selectedArtifactIds: Set<string>
  password: string
  passwordConfirm: string
  outputPath: string | null
  label: string
  backupJobId: string | null
  result: BackupResult | null

  addPaths: (paths: string[]) => void
  removePath: (path: string) => void
  setScanJob: (jobId: string | null) => void
  /** Stores the scan result and resets the selection to the providers' defaults. */
  setScan: (scan: ScanSession | null) => void
  setArtifactSelected: (id: string, selected: boolean) => void
  setSelection: (ids: Iterable<string>) => void
  setPassword: (password: string) => void
  setPasswordConfirm: (password: string) => void
  setOutputPath: (path: string | null) => void
  setLabel: (label: string) => void
  setBackupJob: (jobId: string | null) => void
  setResult: (result: BackupResult | null) => void
  /** Clears everything, including the password. */
  reset: () => void
}

const initial = {
  selectedPaths: [] as string[],
  scanJobId: null,
  scan: null,
  selectedArtifactIds: new Set<string>(),
  password: '',
  passwordConfirm: '',
  outputPath: null,
  label: '',
  backupJobId: null,
  result: null,
}

export const useBackupWizard = create<BackupWizardState>((set) => ({
  ...initial,
  addPaths: (paths) =>
    set((s) => {
      const next = [...s.selectedPaths]
      for (const p of paths) {
        const normalized = p.replace(/\/+$/, '') || p
        if (!next.includes(normalized)) next.push(normalized)
      }
      return { selectedPaths: next }
    }),
  removePath: (path) => set((s) => ({ selectedPaths: s.selectedPaths.filter((p) => p !== path) })),
  setScanJob: (scanJobId) => set({ scanJobId }),
  setScan: (scan) =>
    set({
      scan,
      selectedArtifactIds: scan ? defaultSelectedIds(scan) : new Set<string>(),
      backupJobId: null,
      result: null,
    }),
  setArtifactSelected: (id, selected) =>
    set((s) => {
      if (s.selectedArtifactIds.has(id) === selected) return {}
      const next = new Set(s.selectedArtifactIds)
      if (selected) next.add(id)
      else next.delete(id)
      return { selectedArtifactIds: next }
    }),
  setSelection: (ids) => set({ selectedArtifactIds: new Set(ids) }),
  setPassword: (password) => set({ password }),
  setPasswordConfirm: (passwordConfirm) => set({ passwordConfirm }),
  setOutputPath: (outputPath) => set({ outputPath }),
  setLabel: (label) => set({ label }),
  setBackupJob: (backupJobId) => set({ backupJobId }),
  setResult: (result) => set({ result }),
  reset: () => set({ ...initial, selectedPaths: [], selectedArtifactIds: new Set<string>() }),
}))
