import type { BackupResult, RestorePlan, RestoreResult, ScanSession } from '@devmig/model'
import { describe, expect, it } from 'vitest'
import {
  MOCK_DEMO_BACKUP_PATH,
  MOCK_DEMO_PASSWORD,
  MOCK_UNSUPPORTED_BACKUP_PATH,
  createMockApi,
} from './mock-api'
import { MOCK_PROJECT_PATHS } from './mock-data'
import { parseJobResult } from '../lib/job-result'

const fast = (): ReturnType<typeof createMockApi> =>
  createMockApi({ timeScale: 0, now: () => new Date('2026-08-27T10:00:00.000Z') })

describe('mock api — full backup → restore round trip', () => {
  it('scans, backs up, inspects, plans and restores with structured progress', async () => {
    const api = fast()
    const events: string[] = []

    const { jobId: scanId } = await api.projects.scan({
      paths: MOCK_PROJECT_PATHS,
      includeGlobal: true,
    })
    const off = api.jobs.onProgress(scanId, (e) =>
      events.push(`${e.phase}:${e.item?.id ?? '-'}:${e.item?.status ?? '-'}`),
    )
    const scanSnap = await api.jobs.waitFor(scanId)
    off()
    expect(scanSnap.status).toBe('completed')
    expect(scanSnap.phase).toBe('COMPLETE')
    const scan = parseJobResult('scan', scanSnap) as ScanSession
    expect(scan.projects.map((p) => p.project.name)).toEqual(['looplift', 'playagain'])
    expect(scan.global.length).toBeGreaterThan(0)
    expect(events.some((e) => e.startsWith('SCANNING:proj_looplift:git:done'))).toBe(true)
    expect(events.some((e) => e.startsWith('SCANNING:global:claude-code:done'))).toBe(true)

    await expect(
      api.backups.create({
        scanId: scan.id,
        selectedArtifactIds: [],
        outputPath: '/x.devbackup',
        password: 'short',
        label: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const selected = scan.projects.flatMap((p) =>
      p.providers.flatMap((r) =>
        r.artifacts.filter((a) => a.selectable && a.includedByDefault).map((a) => a.id),
      ),
    )
    const { jobId: backupId } = await api.backups.create({
      scanId: scan.id,
      selectedArtifactIds: selected,
      outputPath: '/Users/cem/Desktop/test.devbackup',
      password: 'correct horse battery',
      label: 'Test',
    })
    const backupSnap = await api.jobs.waitFor(backupId)
    expect(backupSnap.status).toBe('completed')
    const backup = parseJobResult('backup', backupSnap) as BackupResult
    expect(backup.verified).toBe(true)
    expect(backup.manifest.stats.claudeSessionCount).toBe(281)
    expect(backup.manifest.stats.worktreeCount).toBe(3)
    expect(
      backupSnap.recentEvents.some(
        (e) => e.item?.id === 'proj_looplift:git-bundle' && e.item.status === 'done',
      ),
    ).toBe(true)
    expect(
      backupSnap.recentEvents.some((e) => e.item?.id === 'encrypt' && e.item.status === 'done'),
    ).toBe(true)
    expect((await api.system.pathExists('/Users/cem/Desktop/test.devbackup')).exists).toBe(true)

    await expect(
      api.backups.inspect({
        path: '/Users/cem/Desktop/test.devbackup',
        password: 'wrong-password',
      }),
    ).rejects.toMatchObject({
      code: 'ARCHIVE_AUTH_FAILED',
    })
    const inspection = await api.backups.inspect({
      path: '/Users/cem/Desktop/test.devbackup',
      password: 'correct horse battery',
    })
    expect(inspection.manifest.id).toBe(backup.manifest.id)

    const header = await api.backups.readHeader({ path: '/Users/cem/Desktop/test.devbackup' })
    expect(header.supported).toBe(true)
    expect(header.kdf.algorithm).toBe('argon2id')

    const mappings = inspection.manifest.projects.map((p) => ({
      projectId: p.id,
      oldPath: p.canonicalPath,
      newPath: p.name === 'looplift' ? '/Users/new/Projects/looplift' : p.canonicalPath,
    }))
    const preview = await api.restore.previewRemap({
      path: inspection.path,
      password: 'correct horse battery',
      mappings,
    })
    expect(preview.mappings).toHaveLength(1)
    expect(preview.affected.some((a) => a.label.includes('looplift'))).toBe(true)
    expect(preview.unsupportedReferences).toHaveLength(1)

    const allIds = inspection.manifest.projects.flatMap((p) =>
      p.providers.flatMap((s) => s.artifacts.map((a) => a.id)),
    )
    const { jobId: planId } = await api.restore.plan({
      backupPath: inspection.path,
      password: 'correct horse battery',
      mappings,
      selectedArtifactIds: allIds,
      options: { defaultCollisionPolicy: 'skip', includeGlobal: false },
    })
    const planSnap = await api.jobs.waitFor(planId)
    expect(planSnap.status).toBe('completed')
    const plan = parseJobResult('restore-plan', planSnap) as RestorePlan
    expect(plan.canProceed).toBe(true)
    expect(
      plan.projects.find((p) => p.name === 'playagain')?.collisions.map((c) => c.kind),
    ).toEqual(['git-repo-exists', 'claude-project-exists'])
    expect(plan.projects.find((p) => p.name === 'looplift')?.collisions).toEqual([])
    expect(plan.projects.find((p) => p.name === 'looplift')?.pathChanged).toBe(true)

    const { jobId: execId } = await api.restore.execute({
      planId: plan.id,
      collisionDecisions: { 'git:proj_playagain:repo-exists': 'backup-then-replace' },
    })
    const execSnap = await api.jobs.waitFor(execId)
    expect(execSnap.status).toBe('completed')
    const result = parseJobResult('restore', execSnap) as RestoreResult
    expect(result.attention.map((a) => a.id)).toContain('claude-auth')
    expect(
      result.projects
        .find((p) => p.name === 'playagain')
        ?.providers.find((o) => o.providerId === 'git')?.status,
    ).toBe('ok')
    expect(
      result.projects
        .find((p) => p.name === 'playagain')
        ?.providers.find((o) => o.providerId === 'claude-code')?.status,
    ).toBe('skipped')
    expect(
      execSnap.recentEvents.some(
        (e) => e.phase === 'RESTORE_CLAUDE' && e.item?.status === 'skipped',
      ),
    ).toBe(true)
    expect((await api.system.pathExists('/Users/new/Projects/looplift')).exists).toBe(true)
  })

  it('rejects unsupported files and unknown paths', async () => {
    const api = fast()
    expect((await api.backups.readHeader({ path: MOCK_UNSUPPORTED_BACKUP_PATH })).supported).toBe(
      false,
    )
    await expect(
      api.backups.inspect({ path: MOCK_UNSUPPORTED_BACKUP_PATH, password: 'whatever!' }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_UNSUPPORTED_VERSION' })
    await expect(api.backups.readHeader({ path: '/nope.devbackup' })).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
    })
    const demo = await api.backups.inspect({
      path: MOCK_DEMO_BACKUP_PATH,
      password: MOCK_DEMO_PASSWORD,
    })
    expect(demo.manifest.projects).toHaveLength(2)
  })

  it('cancels a running job and reports terminal state to subscribers', async () => {
    const api = createMockApi({ timeScale: 1 })
    const { jobId } = await api.projects.scan({ paths: MOCK_PROJECT_PATHS, includeGlobal: false })
    const states: string[] = []
    const off = api.jobs.onState(jobId, (s) => states.push(s.status))
    const cancelled = await api.jobs.cancel(jobId)
    expect(cancelled.status).toBe('running')
    const final = await api.jobs.waitFor(jobId)
    off()
    expect(final.status).toBe('cancelled')
    expect(final.phase).toBe('CANCELLED')
    expect(final.error?.code).toBe('CANCELLED')
    expect(states).toContain('cancelled')
    await expect(api.jobs.cancel(jobId)).rejects.toMatchObject({ code: 'JOB_ALREADY_FINISHED' })
    await expect(api.jobs.get('job_nope')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
    expect((await api.jobs.list()).map((j) => j.id)).toContain(jobId)
  })

  it('fails the verify job for a wrong password', async () => {
    const api = fast()
    const { jobId } = await api.backups.verify({
      path: MOCK_DEMO_BACKUP_PATH,
      password: 'wrong-wrong',
    })
    const snap = await api.jobs.waitFor(jobId)
    expect(snap.status).toBe('failed')
    expect(snap.error?.code).toBe('ARCHIVE_AUTH_FAILED')
    const ok = await api.jobs.waitFor(
      (await api.backups.verify({ path: MOCK_DEMO_BACKUP_PATH, password: MOCK_DEMO_PASSWORD }))
        .jobId,
    )
    expect(parseJobResult('verify', ok)).toMatchObject({ ok: true })
  })
})
