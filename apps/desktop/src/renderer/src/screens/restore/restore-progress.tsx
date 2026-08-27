import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { GroupedChecklist } from '../../components/grouped-checklist'
import { JobEventLog } from '../../components/job-event-log'
import { ProgressChecklist } from '../../components/progress-checklist'
import { WizardPage } from '../../components/wizard-page'
import { Button } from '../../components/ui/button'
import { ConfirmDialog } from '../../components/ui/confirm-dialog'
import { ErrorPanel } from '../../components/ui/error-panel'
import { Panel } from '../../components/ui/panel'
import { useAsyncAction } from '../../hooks/use-async'
import { checklistFromEvents, useJob } from '../../hooks/use-job'
import { parseJobResult } from '../../lib/job-result'
import { RESTORE_RUN_PHASES, phaseChecklist, phaseLabel } from '../../lib/phases'
import { ROUTES } from '../../lib/routes'
import { useJobsStore } from '../../stores/jobs'
import { useRestoreWizard } from '../../stores/restore-wizard'

export function RestoreProgressScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const executeJobId = useRestoreWizard((s) => s.executeJobId)
  const plan = useRestoreWizard((s) => s.plan)
  const result = useRestoreWizard((s) => s.result)
  const setResult = useRestoreWizard((s) => s.setResult)
  const cancelJob = useJobsStore((s) => s.cancel)
  const view = useJob(executeJobId)
  const jobResult = parseJobResult('restore', view.snapshot ?? undefined)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const cancel = useAsyncAction(async () => {
    if (executeJobId) await cancelJob(executeJobId)
    setConfirmOpen(false)
  })

  useEffect(() => {
    if (!jobResult) return
    if (result?.planId === jobResult.planId && result.durationMs === jobResult.durationMs) return
    setResult(jobResult)
    void navigate(ROUTES.restoreReport)
  }, [jobResult, result, setResult, navigate])

  if (!executeJobId) return <Navigate to={ROUTES.restorePreflight} replace />

  const projectNames: Record<string, string> = {}
  for (const p of plan?.projects ?? []) projectNames[p.projectId] = p.name
  const items = checklistFromEvents(view.events)
  const phases = phaseChecklist(RESTORE_RUN_PHASES, view.lastPhase, view.status, [
    'REPORT',
    'COMPLETE',
  ])
  const statusText = view.isDone
    ? view.status === 'completed'
      ? 'Restore complete'
      : view.status === 'cancelled'
        ? 'Restore cancelled'
        : 'Restore failed'
    : `${phaseLabel(view.lastPhase)} — ${view.snapshot?.message ?? 'Starting…'}`

  return (
    <WizardPage
      title="Restoring"
      description="Providers run in a fixed order and write only inside the approved destinations."
      testId="screen-restore-progress"
      footerStart={
        <span role="status" aria-live="polite" data-testid="restore-status">
          {statusText}
        </span>
      }
      footerEnd={
        <>
          {view.isRunning ? (
            <Button onClick={() => setConfirmOpen(true)} data-testid="restore-cancel">
              Cancel
            </Button>
          ) : null}
          {view.status === 'failed' || view.status === 'cancelled' ? (
            <Button
              variant="primary"
              onClick={() => void navigate(ROUTES.restorePreflight)}
              data-testid="restore-retry"
            >
              Back to plan
            </Button>
          ) : null}
          {view.status === 'completed' ? (
            <Button
              variant="primary"
              onClick={() => void navigate(ROUTES.restoreReport)}
              data-testid="restore-continue"
            >
              View report
            </Button>
          ) : null}
        </>
      }
    >
      {view.snapshot?.error ? (
        <ErrorPanel
          error={
            view.status === 'cancelled'
              ? {
                  ...view.snapshot.error,
                  hint:
                    view.snapshot.error.hint ??
                    'Steps that had already completed stay in place; nothing was deleted. Temporary files were removed. Re-run the plan to see what remains.',
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
      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <Panel testId="restore-phases">
          <ProgressChecklist title="Phases" items={phases} />
        </Panel>
        <GroupedChecklist
          items={items}
          projectNames={projectNames}
          overallLabel="Global environment"
          testId="restore-checklist"
          className="sm:grid-cols-1 lg:grid-cols-2"
        />
      </div>
      <JobEventLog events={view.events} testId="restore-log" />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Cancel the restore?"
        description={
          <>
            Steps that have already finished stay in place — for example a cloned repository — and
            nothing that existed before is deleted. Steps in progress are abandoned and their
            temporary files removed. You can plan the restore again afterwards; collisions will show
            what is already there.
          </>
        }
        confirmLabel="Cancel restore"
        cancelLabel="Keep going"
        destructive
        pending={cancel.pending}
        onConfirm={() => void cancel.run()}
        testId="restore-cancel-dialog"
      />
    </WizardPage>
  )
}
