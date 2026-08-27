import type { PathMapping, PathRemapReport, SerializedError } from '@devmig/model'
import { FolderOpen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { getApi } from '../../api'
import { WarningList } from '../../components/warning-list'
import { WizardPage } from '../../components/wizard-page'
import { Button } from '../../components/ui/button'
import { ErrorPanel } from '../../components/ui/error-panel'
import { Panel } from '../../components/ui/panel'
import { PathText } from '../../components/ui/path-text'
import { StatusIcon } from '../../components/ui/status-icon'
import { inputClass } from '../../components/ui/text-field'
import { useAsyncAction } from '../../hooks/use-async'
import { useDebounced } from '../../hooks/use-debounced'
import { useHomeDir } from '../../hooks/use-home-dir'
import { cn } from '../../lib/cn'
import { toSerializedError } from '../../lib/errors'
import { formatNumber, plural } from '../../lib/format'
import { expandHome, validateDestinationPath } from '../../lib/paths'
import { sessionsForProject } from '../../lib/plan'
import { ROUTES } from '../../lib/routes'
import { useRestoreWizard } from '../../stores/restore-wizard'

const REMAP_DEBOUNCE_MS = 250

interface DestinationInfo {
  exists: boolean
  isDirectory: boolean
  isEmpty: boolean
}

export function RestoreMappingScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir } = useHomeDir()
  const inspection = useRestoreWizard((s) => s.inspection)
  const backupPath = useRestoreWizard((s) => s.backupPath)
  const password = useRestoreWizard((s) => s.password)
  const mappings = useRestoreWizard((s) => s.mappings)
  const setMapping = useRestoreWizard((s) => s.setMapping)
  const selected = useRestoreWizard((s) => s.selectedArtifactIds)
  const includeGlobal = useRestoreWizard((s) => s.includeGlobal)
  const setPlanJob = useRestoreWizard((s) => s.setPlanJob)
  const setPlan = useRestoreWizard((s) => s.setPlan)

  const [reportState, setReportState] = useState<{
    key: string
    report: PathRemapReport | null
    error: SerializedError | null
  } | null>(null)
  const [destinations, setDestinations] = useState<Record<string, DestinationInfo>>({})

  const effectiveMappings = useMemo<PathMapping[]>(
    () => mappings.map((m) => ({ ...m, newPath: expandHome(m.newPath.trim(), homeDir) })),
    [mappings, homeDir],
  )
  const validation = useMemo(
    () => mappings.map((m) => validateDestinationPath(m.newPath)),
    [mappings],
  )
  const allValid = validation.every((v) => v.ok)
  const mappingsKey = JSON.stringify(effectiveMappings)
  const debouncedKey = useDebounced(mappingsKey, REMAP_DEBOUNCE_MS)

  // Debounced remap preview + destination existence checks (results are keyed by the mappings they belong to).
  useEffect(() => {
    if (!backupPath || !inspection) return
    const current = JSON.parse(debouncedKey) as PathMapping[]
    if (current.some((m) => !validateDestinationPath(m.newPath).ok)) return
    let active = true
    const api = getApi()
    if (current.some((m) => m.oldPath !== m.newPath)) {
      api.restore
        .previewRemap({ path: backupPath, password, mappings: current })
        .then((r) => {
          if (active) setReportState({ key: debouncedKey, report: r, error: null })
        })
        .catch((err: unknown) => {
          if (active)
            setReportState({ key: debouncedKey, report: null, error: toSerializedError(err) })
        })
    }
    for (const m of current) {
      api.system
        .pathExists(m.newPath)
        .then((info) => {
          if (active) setDestinations((d) => ({ ...d, [m.newPath]: info }))
        })
        .catch(() => {
          /* existence is advisory; the plan's preflight is authoritative */
        })
    }
    return () => {
      active = false
    }
  }, [debouncedKey, backupPath, password, inspection])

  const changedCount = effectiveMappings.filter((m) => m.oldPath !== m.newPath).length
  const reportFresh =
    reportState !== null && reportState.key === debouncedKey && debouncedKey === mappingsKey
  const report = reportFresh ? reportState.report : null
  const reportError = reportFresh ? reportState.error : null
  const previewing = changedCount > 0 && !reportFresh

  const plan = useAsyncAction(async () => {
    if (!backupPath) return
    const res = await getApi().restore.plan({
      backupPath,
      password,
      mappings: effectiveMappings,
      selectedArtifactIds: [...selected],
      options: { defaultCollisionPolicy: 'skip', includeGlobal },
    })
    setPlan(null)
    setPlanJob(res.jobId)
    void navigate(ROUTES.restorePreflight)
  })

  const chooseFor = useAsyncAction(async (projectId: string, currentPath: string) => {
    const res = await getApi().restore.selectDestination({
      title: 'Choose where to restore this project',
      defaultPath: currentPath,
    })
    if (!res.cancelled && res.path) setMapping(projectId, res.path)
  })

  if (!inspection || !backupPath) return <Navigate to={ROUTES.restore} replace />

  return (
    <WizardPage
      title="Restore locations"
      description="Restore each project to its previous path or somewhere new. When a path changes, Claude Code sessions and worktree metadata are remapped field by field — never with a global find-and-replace."
      backTo={ROUTES.restoreContents}
      testId="screen-restore-mapping"
      footerStart={
        <span data-testid="mapping-summary">
          {changedCount === 0
            ? 'All projects return to their previous paths'
            : `${plural(changedCount, 'project')} will be remapped`}
          {previewing ? ' · checking…' : ''}
        </span>
      }
      footerEnd={
        <Button
          variant="primary"
          onClick={() => void plan.run()}
          disabled={!allValid || plan.pending}
          loading={plan.pending}
          data-testid="mapping-continue"
        >
          Continue
        </Button>
      }
    >
      {plan.error ? <ErrorPanel error={plan.error} /> : null}
      {chooseFor.error ? <ErrorPanel error={chooseFor.error} /> : null}

      {mappings.map((m, index) => {
        const project = inspection.manifest.projects.find((p) => p.id === m.projectId)
        const effective = effectiveMappings[index]
        const valid = validation[index] ?? { ok: true as const }
        const sessions = sessionsForProject(inspection, m.projectId)
        const changed = effective ? effective.oldPath !== effective.newPath : false
        const destination = effective ? destinations[effective.newPath] : undefined
        const inputId = `mapping-input-${index}`
        return (
          <Panel
            key={m.projectId}
            testId={`mapping-project-${index}`}
            title={project?.name ?? m.projectId}
          >
            <div className="grid gap-3 md:grid-cols-[120px_1fr]">
              <span className="pt-1.5 text-[12px] font-medium text-fg-muted">Previous</span>
              <PathText
                path={m.oldPath}
                homeDir={inspection.manifest.machine.homeDir}
                className="pt-1.5 text-fg"
              />
              <label htmlFor={inputId} className="pt-1.5 text-[12px] font-medium text-fg-muted">
                Restore to
              </label>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <input
                    id={inputId}
                    value={m.newPath}
                    onChange={(e) => setMapping(m.projectId, e.target.value)}
                    className={cn(inputClass, 'font-mono text-[12px]')}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-invalid={valid.ok ? undefined : true}
                    aria-describedby={`mapping-status-${index}`}
                    data-testid={inputId}
                  />
                  <Button
                    onClick={() => void chooseFor.run(m.projectId, m.newPath)}
                    loading={chooseFor.pending}
                    data-testid={`mapping-choose-${index}`}
                  >
                    <FolderOpen className="size-4" aria-hidden />
                    Choose…
                  </Button>
                </div>
                <div
                  id={`mapping-status-${index}`}
                  className="flex flex-col gap-1 text-[12.5px]"
                  data-testid={`mapping-status-${index}`}
                  aria-live="polite"
                >
                  {!valid.ok ? (
                    <StatusLine status="error">{valid.reason}</StatusLine>
                  ) : changed ? (
                    <StatusLine status="info" testId={`mapping-remap-${index}`}>
                      {formatNumber(sessions)} Claude sessions require safe path remapping
                      {report ? (
                        <span className="text-fg-muted"> · ✓ safe automatic remap</span>
                      ) : previewing ? (
                        <span className="text-fg-muted"> · checking…</span>
                      ) : null}
                    </StatusLine>
                  ) : (
                    <StatusLine status="ok" testId={`mapping-exact-${index}`}>
                      Exact path match — no remapping needed
                    </StatusLine>
                  )}
                  {valid.ok && destination ? (
                    destination.exists ? (
                      destination.isDirectory && !destination.isEmpty ? (
                        <StatusLine status="warn" testId={`mapping-exists-${index}`}>
                          A non-empty directory already exists here. Existing data is kept; the plan
                          will show collisions to decide on.
                        </StatusLine>
                      ) : destination.isDirectory ? (
                        <StatusLine status="info">Empty directory — will be used as is.</StatusLine>
                      ) : (
                        <StatusLine status="error">A file exists at this path.</StatusLine>
                      )
                    ) : (
                      <StatusLine status="info">Will be created.</StatusLine>
                    )
                  ) : null}
                </div>
              </div>
            </div>
          </Panel>
        )
      })}

      {changedCount > 0 ? (
        <Panel
          title="Remap preview"
          description="Read-only analysis of what would be rewritten. Prose in conversations is never touched."
          testId="mapping-remap-report"
        >
          {reportError ? <ErrorPanel error={reportError} /> : null}
          {report ? (
            <div className="flex flex-col gap-3">
              <p className="text-[13px]">
                <strong className="font-semibold">{formatNumber(report.safeRewriteCount)}</strong>{' '}
                structured references will be rewritten safely.
              </p>
              {report.affected.length > 0 ? (
                <ul className="flex flex-col gap-1 text-[12.5px]">
                  {report.affected.map((a, i) => (
                    <li key={`${a.label}-${i}`} className="flex items-center gap-2">
                      <StatusIcon status="ok" className="size-3.5" />
                      <span>{a.label}</span>
                      <span className="ml-auto font-mono text-fg-muted tabular-nums">
                        {formatNumber(a.count)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <WarningList warnings={report.warnings} variant="plain" />
              {report.unsupportedReferences.length > 0 ? (
                <div>
                  <p className="text-[12px] font-semibold text-fg-muted">
                    Not rewritten (manual follow-up)
                  </p>
                  <ul className="mt-1 flex flex-col gap-1 text-[12.5px]">
                    {report.unsupportedReferences.map((u, i) => (
                      <li key={`${u.location}-${i}`} className="flex gap-2">
                        <StatusIcon status="info" className="mt-px size-3.5" />
                        <span>
                          <span className="font-mono text-[12px]">{u.location}</span> — {u.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : !reportError ? (
            <p className="text-[13px] text-fg-muted">Analysing…</p>
          ) : null}
        </Panel>
      ) : null}
    </WizardPage>
  )
}

function StatusLine({
  status,
  children,
  testId,
}: {
  status: 'ok' | 'info' | 'warn' | 'error'
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <span className="flex items-start gap-1.5" data-testid={testId}>
      <StatusIcon status={status} className="mt-px size-3.5" />
      <span className={cn(status === 'warn' && 'text-warn', status === 'error' && 'text-danger')}>
        {children}
      </span>
    </span>
  )
}
