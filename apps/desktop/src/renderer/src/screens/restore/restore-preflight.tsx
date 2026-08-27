import type { Collision, CollisionPolicy } from '@devmig/model'
import { Play } from 'lucide-react'
import { useEffect } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { getApi } from '../../api'
import { JobEventLog } from '../../components/job-event-log'
import { PhaseStrip } from '../../components/phase-strip'
import { WarningList } from '../../components/warning-list'
import { WizardPage } from '../../components/wizard-page'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ErrorPanel } from '../../components/ui/error-panel'
import { Panel, SectionLabel } from '../../components/ui/panel'
import { PathText } from '../../components/ui/path-text'
import { RadioGroup, RadioItem } from '../../components/ui/radio-group'
import { StatusIcon } from '../../components/ui/status-icon'
import { useAsyncAction } from '../../hooks/use-async'
import { useHomeDir } from '../../hooks/use-home-dir'
import { useJob } from '../../hooks/use-job'
import { providerLabel } from '../../lib/artifacts'
import { cn } from '../../lib/cn'
import { formatNumber, plural } from '../../lib/format'
import { parseJobResult } from '../../lib/job-result'
import { RESTORE_PLAN_PHASES, phaseChecklist, phaseLabel } from '../../lib/phases'
import { blockingFailures, collisionsOf } from '../../lib/plan'
import { ROUTES } from '../../lib/routes'
import { useRestoreWizard } from '../../stores/restore-wizard'

const POLICY_LABELS: Record<CollisionPolicy, { label: string; description: string }> = {
  skip: {
    label: 'Skip',
    description: 'Keep what is on this Mac; nothing from the backup is written here.',
  },
  merge: {
    label: 'Merge',
    description:
      'Add missing items and keep existing ones. Differing copies are kept side by side and reported.',
  },
  'backup-then-replace': {
    label: 'Replace (keep a copy)',
    description:
      'Move the existing copy to <path>.devmig-backup-<timestamp>, then restore from the backup.',
  },
  'alternate-path': {
    label: 'Restore next to it',
    description: 'Restore to an alternate path beside the existing one.',
  },
}

export function RestorePreflightScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir } = useHomeDir()
  const planJobId = useRestoreWizard((s) => s.planJobId)
  const plan = useRestoreWizard((s) => s.plan)
  const setPlan = useRestoreWizard((s) => s.setPlan)
  const decisions = useRestoreWizard((s) => s.collisionDecisions)
  const setDecision = useRestoreWizard((s) => s.setCollisionDecision)
  const setExecuteJob = useRestoreWizard((s) => s.setExecuteJob)
  const view = useJob(planJobId)
  const jobPlan = parseJobResult('restore-plan', view.snapshot ?? undefined)

  useEffect(() => {
    if (!jobPlan) return
    if (plan?.id === jobPlan.id) return
    setPlan(jobPlan)
  }, [jobPlan, plan?.id, setPlan])

  const execute = useAsyncAction(async () => {
    if (!plan) return
    const res = await getApi().restore.execute({ planId: plan.id, collisionDecisions: decisions })
    setExecuteJob(res.jobId)
    void navigate(ROUTES.restoreProgress)
  })

  if (!planJobId && !plan) return <Navigate to={ROUTES.restoreMapping} replace />

  if (!plan) {
    const phases = phaseChecklist(RESTORE_PLAN_PHASES, view.lastPhase, view.status, ['COMPLETE'])
    const failed = view.status === 'failed' || view.status === 'cancelled'
    return (
      <WizardPage
        title="Planning the restore"
        description="The backup is decrypted into a private staging directory and validated. No destination is written."
        backTo={ROUTES.restoreMapping}
        backDisabled={view.isRunning}
        testId="screen-restore-preflight"
        footerStart={
          <span role="status" aria-live="polite" data-testid="plan-status">
            {failed
              ? 'Planning failed'
              : `${phaseLabel(view.lastPhase)} — ${view.snapshot?.message ?? 'Starting…'}`}
          </span>
        }
        footerEnd={
          failed ? (
            <Button
              variant="primary"
              onClick={() => void navigate(ROUTES.restoreMapping)}
              data-testid="plan-retry"
            >
              Back to locations
            </Button>
          ) : null
        }
      >
        <PhaseStrip phases={phases} />
        {view.snapshot?.error ? <ErrorPanel error={view.snapshot.error} /> : null}
        {view.job.lookupError ? (
          <ErrorPanel
            error={{ code: 'JOB_NOT_FOUND', message: view.job.lookupError, recoverable: true }}
          />
        ) : null}
        <JobEventLog events={view.events} testId="plan-log" />
      </WizardPage>
    )
  }

  const collisions = collisionsOf(plan)
  const blockers = blockingFailures(plan)
  const unresolved = collisions.filter((c) => !decisions[c.id])
  const canExecute =
    plan.canProceed && blockers.length === 0 && unresolved.length === 0 && !execute.pending
  const warnChecks = plan.preflight.filter((c) => c.status === 'warn').length
  const stepCount = plan.projects.reduce((n, p) => n + p.steps.length, 0) + plan.globalSteps.length

  return (
    <WizardPage
      title="Review the restore plan"
      description="Nothing has been written yet. Collisions default to the non-destructive choice; every write goes to the destinations listed below and nowhere else."
      backTo={ROUTES.restoreMapping}
      testId="screen-restore-preflight"
      footerStart={
        <span data-testid="plan-summary">
          {plural(stepCount, 'step')} · {plural(collisions.length, 'collision')}
          {blockers.length > 0
            ? ` · ${plural(blockers.length, 'blocking check')} failed`
            : warnChecks > 0
              ? ` · ${plural(warnChecks, 'warning')}`
              : ' · preflight passed'}
        </span>
      }
      footerEnd={
        <Button
          variant="primary"
          onClick={() => void execute.run()}
          disabled={!canExecute}
          loading={execute.pending}
          data-testid="plan-execute"
        >
          <Play className="size-4" aria-hidden />
          Start restore
        </Button>
      }
    >
      {execute.error ? <ErrorPanel error={execute.error} /> : null}
      {blockers.length > 0 ? (
        <ErrorPanel
          testId="plan-blocked"
          error={{
            code: 'RESTORE_PLAN_REJECTED',
            message: `${plural(blockers.length, 'blocking check')} failed: ${blockers.map((b) => b.label).join(', ')}.`,
            hint: 'Fix the cause and go back one step to plan again.',
            recoverable: true,
          }}
        />
      ) : null}
      <WarningList warnings={plan.warnings} testId="plan-warnings" />

      <SectionLabel>Preflight checks</SectionLabel>
      <Panel padded={false} testId="plan-preflight">
        <ul className="divide-y divide-border px-4">
          {plan.preflight.map((check) => (
            <li
              key={check.id}
              className="flex items-start gap-3 py-2"
              data-testid={`preflight-check-${check.id}`}
              data-status={check.status}
            >
              <StatusIcon status={check.status} className="mt-0.5" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-center gap-2 text-[13px]">
                  {check.label}
                  {check.blocking ? (
                    <Badge tone={check.status === 'fail' ? 'danger' : 'neutral'}>Blocking</Badge>
                  ) : null}
                  {check.providerId ? (
                    <span className="text-[11px] text-fg-faint">
                      {providerLabel(check.providerId)}
                    </span>
                  ) : null}
                </span>
                {check.detail ? (
                  <span
                    className={cn(
                      'text-[12px] text-fg-muted',
                      check.status === 'fail' && 'text-danger',
                    )}
                  >
                    {check.detail}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <SectionLabel className="mt-2">Collisions</SectionLabel>
      {collisions.length === 0 ? (
        <Panel testId="plan-collisions-none">
          <p className="flex items-center gap-2 text-[13px] text-fg-muted">
            <StatusIcon status="ok" /> No existing data at any destination.
          </p>
        </Panel>
      ) : (
        <div className="flex flex-col gap-3" data-testid="plan-collisions">
          {collisions.map((c) => (
            <CollisionCard
              key={c.id}
              collision={c}
              value={decisions[c.id] ?? c.policy}
              onChange={(p) => setDecision(c.id, p)}
              homeDir={homeDir}
              projectName={plan.projects.find((p) => p.projectId === c.projectId)?.name}
            />
          ))}
        </div>
      )}

      <SectionLabel className="mt-2">Path remapping</SectionLabel>
      <Panel testId="plan-remap">
        {plan.remap.mappings.length === 0 ? (
          <p className="flex items-center gap-2 text-[13px] text-fg-muted">
            <StatusIcon status="ok" /> All projects return to their previous paths; nothing is
            rewritten.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1 text-[12.5px]">
              {plan.remap.mappings.map((m) => (
                <li key={m.projectId} className="flex flex-wrap items-center gap-2">
                  <PathText path={m.oldPath} />
                  <span className="text-fg-faint">→</span>
                  <PathText path={m.newPath} homeDir={homeDir} className="text-fg" />
                </li>
              ))}
            </ul>
            <p className="text-[13px]">
              <strong className="font-semibold">{formatNumber(plan.remap.safeRewriteCount)}</strong>{' '}
              structured references rewritten safely
            </p>
            {plan.remap.affected.length > 0 ? (
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {plan.remap.affected.map((a, i) => (
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
            <WarningList warnings={plan.remap.warnings} variant="plain" />
            {plan.remap.unsupportedReferences.length > 0 ? (
              <ul className="flex flex-col gap-1 text-[12.5px]" data-testid="plan-unsupported">
                {plan.remap.unsupportedReferences.map((u, i) => (
                  <li key={`${u.location}-${i}`} className="flex gap-2">
                    <StatusIcon status="info" className="mt-px size-3.5" />
                    <span>
                      <span className="font-mono text-[12px]">{u.location}</span> — {u.reason}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </Panel>

      <SectionLabel className="mt-2">Steps</SectionLabel>
      {plan.projects.map((p) => (
        <Panel
          key={p.projectId}
          testId={`plan-project-${p.projectId}`}
          padded={false}
          title={p.name}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <PathText path={p.newPath} homeDir={homeDir} />
              {p.pathChanged ? <Badge tone="accent">Path changed</Badge> : null}
            </span>
          }
        >
          <WarningList warnings={p.warnings} variant="inset" />
          <ol className="divide-y divide-border px-4">
            {p.steps.map((s, i) => (
              <li
                key={s.id}
                className="flex items-start gap-3 py-2 text-[13px]"
                data-testid={`plan-step-${s.id}`}
              >
                <span className="w-5 shrink-0 text-right font-mono text-[11px] text-fg-faint tabular-nums">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span>
                    {s.label}{' '}
                    <span className="text-[11px] text-fg-faint">
                      · {providerLabel(s.providerId)}
                    </span>
                  </span>
                  {s.detail ? <span className="text-[12px] text-fg-muted">{s.detail}</span> : null}
                  {s.destination ? (
                    <PathText path={s.destination} homeDir={homeDir} className="text-[11px]" />
                  ) : null}
                </div>
              </li>
            ))}
            {p.steps.length === 0 ? (
              <li className="py-2 text-[12.5px] text-fg-faint">
                Nothing selected for this project.
              </li>
            ) : null}
          </ol>
        </Panel>
      ))}
      {plan.globalSteps.length > 0 ? (
        <Panel title="Global Claude Code Environment" padded={false} testId="plan-global">
          <ol className="divide-y divide-border px-4">
            {plan.globalSteps.map((s, i) => (
              <li
                key={s.id}
                className="flex items-start gap-3 py-2 text-[13px]"
                data-testid={`plan-step-${s.id}`}
              >
                <span className="w-5 shrink-0 text-right font-mono text-[11px] text-fg-faint tabular-nums">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span>{s.label}</span>
                  {s.destination ? (
                    <PathText path={s.destination} homeDir={homeDir} className="text-[11px]" />
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}
    </WizardPage>
  )
}

function CollisionCard({
  collision,
  value,
  onChange,
  homeDir,
  projectName,
}: {
  collision: Collision
  value: CollisionPolicy
  onChange: (policy: CollisionPolicy) => void
  homeDir: string | null
  projectName: string | undefined
}): React.JSX.Element {
  const destructive = value === 'backup-then-replace'
  return (
    <Panel
      testId={`collision-${collision.id}`}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <StatusIcon status="warn" />
          {KIND_LABELS[collision.kind]}
          {projectName ? <span className="font-normal text-fg-muted">· {projectName}</span> : null}
          <span className="text-[11px] font-normal text-fg-faint">
            {providerLabel(collision.providerId)}
          </span>
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          <PathText path={collision.path} homeDir={homeDir} />
          <span>{collision.detail}</span>
        </span>
      }
    >
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as CollisionPolicy)}
        aria-label={`Policy for ${collision.path}`}
        data-testid={`collision-${collision.id}-policy`}
      >
        {collision.allowedPolicies.map((policy) => (
          <RadioItem
            key={policy}
            id={`collision-${collision.id}-${policy}`}
            value={policy}
            label={POLICY_LABELS[policy].label}
            description={POLICY_LABELS[policy].description}
            data-testid={`collision-${collision.id}-${policy}`}
          />
        ))}
      </RadioGroup>
      {destructive ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-warn" role="status">
          <StatusIcon status="warn" className="size-3.5" /> The existing copy is moved aside, not
          deleted. You can remove it yourself later.
        </p>
      ) : null}
    </Panel>
  )
}

const KIND_LABELS: Record<Collision['kind'], string> = {
  'directory-exists': 'Directory already exists',
  'file-exists': 'File already exists',
  'git-repo-exists': 'Git repository already exists',
  'claude-project-exists': 'Claude Code project already exists',
  'worktree-path-exists': 'Worktree path already exists',
  'json-entry-exists': 'Entries already exist',
}
