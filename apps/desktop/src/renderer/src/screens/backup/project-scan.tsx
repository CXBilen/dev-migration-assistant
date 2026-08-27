import { useEffect } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { GroupedChecklist } from '../../components/grouped-checklist'
import { JobEventLog } from '../../components/job-event-log'
import { PhaseStrip } from '../../components/phase-strip'
import { WizardPage } from '../../components/wizard-page'
import { Button } from '../../components/ui/button'
import { ErrorPanel } from '../../components/ui/error-panel'
import { checklistFromEvents, useJob } from '../../hooks/use-job'
import { useAsyncAction } from '../../hooks/use-async'
import { basename } from '../../lib/paths'
import { parseJobResult } from '../../lib/job-result'
import { phaseChecklist, phaseLabel } from '../../lib/phases'
import { ROUTES } from '../../lib/routes'
import { useBackupWizard } from '../../stores/backup-wizard'
import { useJobsStore } from '../../stores/jobs'

const SCAN_PHASES = ['DISCOVERING', 'SCANNING'] as const

export function ProjectScanScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const scanJobId = useBackupWizard((s) => s.scanJobId)
  const scan = useBackupWizard((s) => s.scan)
  const selectedPaths = useBackupWizard((s) => s.selectedPaths)
  const setScan = useBackupWizard((s) => s.setScan)
  const cancelJob = useJobsStore((s) => s.cancel)
  const view = useJob(scanJobId)
  const result = parseJobResult('scan', view.snapshot ?? undefined)
  const cancel = useAsyncAction(async () => {
    if (scanJobId) await cancelJob(scanJobId)
  })

  // Store the result once and move on automatically; returning to this screen later shows the finished state.
  useEffect(() => {
    if (!result) return
    if (scan?.id === result.id) return
    setScan(result)
    void navigate(ROUTES.backupReview)
  }, [result, scan?.id, setScan, navigate])

  if (!scanJobId) return <Navigate to={ROUTES.backupProjects} replace />

  const items = checklistFromEvents(view.events)
  const projectNames: Record<string, string> = {}
  for (const item of items)
    if (item.projectId && !projectNames[item.projectId])
      projectNames[item.projectId] = item.projectId
  if (result) for (const p of result.projects) projectNames[p.project.id] = p.project.name
  else
    for (const item of items)
      if (item.projectId) {
        const match = view.events.find((e) => e.projectId === item.projectId && e.item)
        const name = selectedPaths
          .map((p) => basename(p))
          .find((n) => match?.message.startsWith(`${n}:`))
        if (name) projectNames[item.projectId] = name
      }

  const phases = phaseChecklist(SCAN_PHASES, view.lastPhase, view.status, ['COMPLETE'])
  const failed = view.status === 'failed' || view.status === 'cancelled'
  const statusText = view.isDone
    ? view.status === 'completed'
      ? 'Scan complete'
      : view.status === 'cancelled'
        ? 'Scan cancelled'
        : 'Scan failed'
    : `${phaseLabel(view.lastPhase)} — ${view.snapshot?.message ?? 'Starting…'}`

  return (
    <WizardPage
      title="Scanning projects"
      description="Every provider inspects the selected folders read-only: nothing is written during a scan."
      backTo={ROUTES.backupProjects}
      backDisabled={view.isRunning}
      testId="screen-scan"
      footerStart={
        <span role="status" aria-live="polite" data-testid="scan-status">
          {statusText}
        </span>
      }
      footerEnd={
        <>
          {view.isRunning ? (
            <Button
              onClick={() => void cancel.run()}
              loading={cancel.pending}
              data-testid="scan-cancel"
            >
              Cancel
            </Button>
          ) : null}
          {failed ? (
            <Button
              variant="primary"
              onClick={() => void navigate(ROUTES.backupProjects)}
              data-testid="scan-retry"
            >
              Back to projects
            </Button>
          ) : null}
          {view.status === 'completed' ? (
            <Button
              variant="primary"
              onClick={() => void navigate(ROUTES.backupReview)}
              data-testid="scan-continue"
            >
              Continue
            </Button>
          ) : null}
        </>
      }
    >
      <PhaseStrip phases={phases} />
      {view.snapshot?.error ? <ErrorPanel error={view.snapshot.error} /> : null}
      {view.job.lookupError ? (
        <ErrorPanel
          error={{ code: 'JOB_NOT_FOUND', message: view.job.lookupError, recoverable: true }}
        />
      ) : null}
      <GroupedChecklist
        items={items}
        projectNames={projectNames}
        overallLabel="Global environment"
        testId="scan-checklist"
      />
      <JobEventLog events={view.events} testId="scan-log" />
    </WizardPage>
  )
}
