import { describe, expect, it } from 'vitest'
import { MOCK_PROJECT_PATHS } from '../api/mock-data'
import { useBackupWizard } from './backup-wizard'
import { useJobsStore } from './jobs'
import { useRestoreWizard } from './restore-wizard'
import { demoInspection, installMockApi, mockScan } from '../test/helpers'

describe('backup wizard store', () => {
  it('dedupes paths, seeds the default selection from a scan, and resets everything', () => {
    installMockApi()
    const s = useBackupWizard.getState()
    s.addPaths([MOCK_PROJECT_PATHS[0] ?? '', `${MOCK_PROJECT_PATHS[0] ?? ''}/`])
    expect(useBackupWizard.getState().selectedPaths).toHaveLength(1)
    s.setScan(mockScan())
    expect(useBackupWizard.getState().selectedArtifactIds.has('git:proj_looplift:bundle')).toBe(
      true,
    )
    expect(useBackupWizard.getState().selectedArtifactIds.has('files:proj_looplift:env')).toBe(
      false,
    )
    s.setArtifactSelected('files:proj_looplift:env', true)
    expect(useBackupWizard.getState().selectedArtifactIds.has('files:proj_looplift:env')).toBe(true)
    s.setPassword('secret-secret')
    s.reset()
    expect(useBackupWizard.getState().password).toBe('')
    expect(useBackupWizard.getState().scan).toBeNull()
    expect(useBackupWizard.getState().selectedArtifactIds.size).toBe(0)
  })
})

describe('restore wizard store', () => {
  it('derives mappings and selection from the inspection and seeds collision decisions', async () => {
    const api = installMockApi()
    const inspection = await demoInspection(api)
    const s = useRestoreWizard.getState()
    s.setInspection(inspection)
    const state = useRestoreWizard.getState()
    expect(state.mappings.map((m) => m.newPath)).toEqual(
      inspection.manifest.projects.map((p) => p.canonicalPath),
    )
    expect(state.selectedArtifactIds.has('claude:global:settings')).toBe(false)
    s.setIncludeGlobal(true)
    expect(useRestoreWizard.getState().selectedArtifactIds.has('claude:global:settings')).toBe(true)
    s.setIncludeGlobal(false)
    expect(useRestoreWizard.getState().selectedArtifactIds.has('claude:global:settings')).toBe(
      false,
    )
    s.setMapping('proj_looplift', '/tmp/x')
    expect(useRestoreWizard.getState().mappings[0]?.newPath).toBe('/tmp/x')
  })
})

describe('jobs store', () => {
  it('tracks a job to completion and stops listening when untracked', async () => {
    const api = installMockApi()
    const { jobId } = await api.projects.scan({ paths: MOCK_PROJECT_PATHS, includeGlobal: false })
    const untrack = useJobsStore.getState().track(jobId)
    await api.jobs.waitFor(jobId)
    await new Promise((r) => setTimeout(r, 0))
    const job = useJobsStore.getState().jobs[jobId]
    expect(job?.snapshot?.status).toBe('completed')
    expect(job?.events.length).toBeGreaterThan(3)
    expect(job?.events.some((e) => e.item?.status === 'done')).toBe(true)
    untrack()
    useJobsStore.getState().forget(jobId)
    expect(useJobsStore.getState().jobs[jobId]).toBeUndefined()
  })
})
