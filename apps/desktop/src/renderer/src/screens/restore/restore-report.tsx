import type { AttentionItem, ProviderRestoreOutcome } from '@devmig/model'
import { FolderOpen, Terminal } from 'lucide-react'
import { useNavigate } from 'react-router'
import { getApi } from '../../api'
import { WarningList } from '../../components/warning-list'
import { WizardPage } from '../../components/wizard-page'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { ErrorPanel } from '../../components/ui/error-panel'
import { Panel, SectionLabel } from '../../components/ui/panel'
import { PathText } from '../../components/ui/path-text'
import { StatusIcon } from '../../components/ui/status-icon'
import { useAsyncAction } from '../../hooks/use-async'
import { useHomeDir } from '../../hooks/use-home-dir'
import { providerLabel } from '../../lib/artifacts'
import { cn } from '../../lib/cn'
import { formatDuration, plural } from '../../lib/format'
import { ROUTES } from '../../lib/routes'
import { useRestoreWizard } from '../../stores/restore-wizard'

const OUTCOME_TONE: Record<
  ProviderRestoreOutcome['status'],
  { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }
> = {
  ok: { tone: 'ok', label: 'Restored' },
  partial: { tone: 'warn', label: 'Partially restored' },
  failed: { tone: 'danger', label: 'Failed' },
  skipped: { tone: 'neutral', label: 'Skipped' },
}

const ACTION_LABELS: Record<AttentionItem['action'], string> = {
  reauth: 'Sign in again',
  install: 'Install',
  manual: 'Manual step',
  none: '',
}

export function RestoreReportScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir } = useHomeDir()
  const result = useRestoreWizard((s) => s.result)
  const setPassword = useRestoreWizard((s) => s.setPassword)
  const openTerminal = useAsyncAction(async (path: string) => {
    await getApi().system.openInTerminal(path)
  })
  const openFinder = useAsyncAction(async (path: string) => {
    await getApi().system.openInFinder(path)
  })

  // No redirect here: a finished wizard's state may be cleared while this screen is still mounted.
  if (!result)
    return (
      <WizardPage title="No report to show" testId="restore-complete-empty" narrow>
        <EmptyState
          icon={<Terminal />}
          title="This restore run has ended"
          description="Open a backup from Home to plan another restore."
          action={
            <Button variant="primary" onClick={() => void navigate(ROUTES.home)}>
              Back to Home
            </Button>
          }
        />
      </WizardPage>
    )

  const failedProviders = result.projects.flatMap((p) =>
    p.providers.filter((o) => o.status === 'failed'),
  ).length
  const verificationFailed = result.verification.checks.filter((c) => c.status === 'fail').length
  const headline =
    failedProviders > 0 || verificationFailed > 0
      ? 'Restore finished with problems'
      : result.verification.ok
        ? 'Restore verified'
        : 'Restore finished'

  return (
    <WizardPage
      title={headline}
      description={`${plural(result.projects.length, 'project')} in ${formatDuration(result.durationMs)}. ${
        result.attention.length > 0
          ? `${plural(result.attention.length, 'item')} need your attention.`
          : 'Nothing else to do.'
      }`}
      testId="restore-complete"
      footerEnd={
        <Button
          variant="primary"
          onClick={() => {
            setPassword('')
            void navigate(ROUTES.home)
          }}
          data-testid="report-done"
        >
          Done
        </Button>
      }
    >
      {openTerminal.error ? <ErrorPanel error={openTerminal.error} /> : null}
      {openFinder.error ? <ErrorPanel error={openFinder.error} /> : null}
      <WarningList warnings={result.warnings} testId="report-warnings" />

      {result.attention.length > 0 ? (
        <>
          <SectionLabel>Needs attention</SectionLabel>
          <Panel padded={false} testId="report-attention">
            <ul className="divide-y divide-border px-4">
              {result.attention.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-3 py-2.5"
                  data-testid={`report-attention-${item.id}`}
                >
                  <StatusIcon status={item.level} className="mt-0.5" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                      {item.title}
                      {item.action !== 'none' ? (
                        <Badge tone={item.level === 'warn' ? 'warn' : 'neutral'}>
                          {ACTION_LABELS[item.action]}
                        </Badge>
                      ) : null}
                      {item.providerId ? (
                        <span className="text-[11px] font-normal text-fg-faint">
                          {providerLabel(item.providerId)}
                        </span>
                      ) : null}
                    </span>
                    {item.detail ? (
                      <span className="selectable text-[12.5px] text-fg-muted">{item.detail}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      ) : null}

      <SectionLabel className="mt-2">Projects</SectionLabel>
      {result.projects.map((p, index) => (
        <Panel
          key={p.projectId}
          testId={`report-project-${p.projectId}`}
          padded={false}
          title={p.name}
          description={<PathText path={p.newPath} homeDir={homeDir} />}
          actions={
            <>
              <Button
                size="sm"
                onClick={() => void openFinder.run(p.newPath)}
                data-testid={`report-show-in-finder-${index}`}
              >
                <FolderOpen className="size-3.5" aria-hidden />
                Show in Finder
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void openTerminal.run(p.newPath)}
                data-testid={`report-open-terminal-${index}`}
              >
                <Terminal className="size-3.5" aria-hidden />
                Open {p.name} in Terminal
              </Button>
            </>
          }
        >
          <div className="divide-y divide-border px-4">
            {p.providers.map((o) => (
              <OutcomeSection key={o.providerId} outcome={o} />
            ))}
            {p.providers.length === 0 ? (
              <p className="py-3 text-[12.5px] text-fg-faint">
                Nothing was restored for this project.
              </p>
            ) : null}
          </div>
        </Panel>
      ))}

      {result.global.length > 0 ? (
        <Panel title="Global Claude Code Environment" padded={false} testId="report-global">
          <div className="divide-y divide-border px-4">
            {result.global.map((o) => (
              <OutcomeSection key={o.providerId} outcome={o} />
            ))}
          </div>
        </Panel>
      ) : null}

      <SectionLabel className="mt-2">Verification</SectionLabel>
      <Panel padded={false} testId="report-verification">
        {result.verification.checks.length === 0 ? (
          <p className="px-4 py-3 text-[12.5px] text-fg-faint">No verification checks were run.</p>
        ) : (
          <ul className="divide-y divide-border px-4">
            {result.verification.checks.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-3 py-2"
                data-testid={`report-check-${c.id}`}
                data-status={c.status}
              >
                <StatusIcon status={c.status} className="mt-0.5" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px]">{c.label}</span>
                  {c.detail ? (
                    <span
                      className={cn(
                        'text-[12px] text-fg-muted',
                        c.status === 'fail' && 'text-danger',
                      )}
                    >
                      {c.detail}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </WizardPage>
  )
}

function OutcomeSection({ outcome }: { outcome: ProviderRestoreOutcome }): React.JSX.Element {
  const tone = OUTCOME_TONE[outcome.status]
  return (
    <section
      className="py-2.5"
      data-testid={`report-outcome-${outcome.projectId ?? 'global'}-${outcome.providerId}`}
      data-status={outcome.status}
    >
      <div className="flex items-center gap-2">
        <h4 className="text-[12.5px] font-semibold">{providerLabel(outcome.providerId)}</h4>
        <Badge tone={tone.tone}>{tone.label}</Badge>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {outcome.items.map((item, i) => (
          <li key={`${item.label}-${i}`} className="flex items-start gap-2 text-[12.5px]">
            <StatusIcon status={item.status} className="mt-px size-3.5" />
            <span>
              <span
                className={cn(
                  item.status === 'warn' && 'text-warn',
                  item.status === 'error' && 'text-danger',
                )}
              >
                {item.label}
              </span>
              {item.detail ? (
                <span className="selectable text-fg-muted"> — {item.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
        {outcome.warnings.map((w) => (
          <li key={w} className="flex items-start gap-2 text-[12.5px] text-warn">
            <StatusIcon status="warn" className="mt-px size-3.5" />
            {w}
          </li>
        ))}
      </ul>
    </section>
  )
}
