import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { GroupedChecklist } from '../../components/grouped-checklist'
import { JobEventLog } from '../../components/job-event-log'
import { PhaseStrip } from '../../components/phase-strip'
import { WizardPage } from '../../components/wizard-page'
import { Button } from '../../components/ui/button'
import { ConfirmDialog } from '../../components/ui/confirm-dialog'
import { ErrorPanel } from '../../components/ui/error-panel'
import { useAsyncAction } from '../../hooks/use-async'
import { checklistFromEvents, useJob } from '../../hooks/use-job'
import { parseJobResult } from '../../lib/job-result'
import { BACKUP_RUN_PHASES, phaseChecklist, phaseLabel } from '../../lib/phases'
import { ROUTES } from '../../lib/routes'
import { useBackupWizard } from '../../stores/backup-wizard'
import { useJobsStore } from '../../stores/jobs'

export function BackupProgressScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const backupJobId = useBackupWizard((s) => s.backupJobId)
  const scan = useBackupWizard((s) => s.scan)
  const result = useBackupWizard((s) => s.result)
  const setResult = useBackupWizard((s) => s.setResult)
  const cancelJob = useJobsStore((s) => s.cancel)
  const view = useJob(backupJobId)
  const jobResult = parseJobResult('backup', view.snapshot ?? undefined)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const cancel = useAsyncAction(async () => {
    if (backupJobId) await cancelJob(backupJobId)
    setConfirmOpen(false)
  })

  useEffect(() => {
    if (!jobResult) return
    if (result?.outputPath === jobResult.outputPath && result.manifest.id === jobResult.manifest.id)
      return
    setResult(jobResult)
    void navigate(ROUTES.backupComplete)
  }, [jobResult, result, setResult, navigate])

  if (!backupJobId) return <Navigate to={ROUTES.backupSecurity} replace />

  const projectNames: Record<string, string> = {}
  for (const p of scan?.projects ?? []) projectNames[p.project.id] = p.project.name
  const items = checklistFromEvents(view.events)
  const phases = phaseChecklist(BACKUP_RUN_PHASES, view.lastPhase, view.status, ['COMPLETE'])
  const statusText = view.isDone
    ? view.status === 'completed'
      ? 'Backup verified'
      : view.status === 'cancelled'
        ? 'Backup cancelled'
        : 'Backup failed'
    : `${phaseLabel(view.lastPhase)} — ${view.snapshot?.message ?? 'Starting…'}`

  return (
    <WizardPage
      title="Creating encrypted backup"
      description="Sources are read, never modified. Cancelling discards the partial file."
      testId="screen-backup-progress"
      footerStart={
        <span role="status" aria-live="polite" data-testid="backup-status">
          {statusText}
        </span>
      }
      footerEnd={
        <>
          {view.isRunning ? (
            <Button onClick={() => setConfirmOpen(true)} data-testid="backup-cancel">
              Cancel
            </Button>
          ) : null}
          {view.status === 'failed' || view.status === 'cancelled' ? (
            <Button
              variant="primary"
              onClick={() => void navigate(ROUTES.backupSecurity)}
              data-testid="backup-retry"
            >
              <ArrowLeft className="size-4" aria-hidden />
              Back to security review
            </Button>
          ) : null}
          {view.status === 'completed' ? (
            <Button
              variant="primary"
              onClick={() => void navigate(ROUTES.backupComplete)}
              data-testid="backup-continue"
            >
              Continue
            </Button>
          ) : null}
        </>
      }
    >
      <PhaseStrip phases={phases} />
      {view.snapshot?.error ? (
        <ErrorPanel
          error={
            view.status === 'cancelled'
              ? {
                  ...view.snapshot.error,
                  hint:
                    view.snapshot.error.hint ??
                    'The partial file was discarded. Nothing on this Mac was modified.',
                }
              : view.snapshot.error
          }
        />
      ) : null}
      {view.job.lookupError ? (
        <ErrorPanel
          error={{ code: 'JOB_NOT_FOUND', message: view.job.lookupError, recoverable: true }}
        />
      ) : null}
      <GroupedChecklist
        items={items}
        projectNames={projectNames}
        overallLabel="Backup file"
        testId="backup-checklist"
      />
      <JobEventLog events={view.events} testId="backup-log" />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Cancel this backup?"
        description="The partially written file will be removed. Nothing on this Mac has been modified — you can start again at any time."
        confirmLabel="Cancel backup"
        cancelLabel="Keep going"
        destructive
        pending={cancel.pending}
        onConfirm={() => void cancel.run()}
        testId="backup-cancel-dialog"
      />
    </WizardPage>
  )
}
