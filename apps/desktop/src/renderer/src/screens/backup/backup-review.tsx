import type { ProjectScanResult } from '@devmig/model'
import { GitBranch } from 'lucide-react'
import { Navigate, useNavigate } from 'react-router'
import { ProviderSection } from '../../components/provider-section'
import { WarningList } from '../../components/warning-list'
import { WizardPage } from '../../components/wizard-page'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Panel, SectionLabel } from '../../components/ui/panel'
import { PathText } from '../../components/ui/path-text'
import { useHomeDir } from '../../hooks/use-home-dir'
import { useShowEphemeral } from '../../hooks/use-prefs'
import { needsReview, providerLabel, providerRank } from '../../lib/artifacts'
import { formatBytes, plural } from '../../lib/format'
import { ROUTES } from '../../lib/routes'
import { computeTotals, defaultSelectedIds, providerResultsSorted } from '../../lib/totals'
import { useBackupWizard } from '../../stores/backup-wizard'

export function BackupReviewScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir } = useHomeDir()
  const [showEphemeral] = useShowEphemeral()
  const scan = useBackupWizard((s) => s.scan)
  const selected = useBackupWizard((s) => s.selectedArtifactIds)
  const setArtifactSelected = useBackupWizard((s) => s.setArtifactSelected)
  const setSelection = useBackupWizard((s) => s.setSelection)

  if (!scan) return <Navigate to={ROUTES.backupProjects} replace />

  const totals = computeTotals(scan, selected)
  const weakCount = scan.projects.flatMap((p) =>
    p.providers.flatMap((r) => r.artifacts.filter(needsReview)),
  ).length

  return (
    <WizardPage
      title="Review what will be backed up"
      description="Everything below was detected on this Mac. Sensitive files are excluded until you opt in on the next step; credentials are never migrated."
      backTo={ROUTES.backupScan}
      testId="screen-review"
      headerEnd={
        <Button
          size="sm"
          onClick={() => setSelection(defaultSelectedIds(scan))}
          data-testid="review-reset-defaults"
        >
          Reset to defaults
        </Button>
      }
      footerStart={
        <span data-testid="review-totals" className="flex flex-wrap gap-x-4 gap-y-1">
          <span>
            Estimated{' '}
            <strong className="font-semibold text-fg" data-testid="review-total-size">
              {formatBytes(totals.bytes)}
            </strong>
          </span>
          <span>
            <strong className="font-semibold text-fg" data-testid="review-total-sessions">
              {totals.sessions.toLocaleString('en-US')}
            </strong>{' '}
            sessions
          </span>
          <span>
            <strong className="font-semibold text-fg" data-testid="review-total-worktrees">
              {totals.worktrees}
            </strong>{' '}
            worktrees
          </span>
          <span>
            <strong className="font-semibold text-fg" data-testid="review-total-artifacts">
              {totals.artifacts}
            </strong>{' '}
            items
          </span>
        </span>
      }
      footerEnd={
        <Button
          variant="primary"
          onClick={() => void navigate(ROUTES.backupSecurity)}
          disabled={totals.artifacts === 0}
          data-testid="review-continue"
        >
          Continue
        </Button>
      }
    >
      <WarningList warnings={scan.warnings} testId="review-warnings" />
      {weakCount > 0 ? (
        <p className="text-[13px] text-fg-muted" data-testid="review-weak-notice">
          <Badge tone="warn">Needs review</Badge>{' '}
          {plural(weakCount, 'Claude Code match', 'Claude Code matches')} could not be confirmed by
          transcript evidence and {weakCount === 1 ? 'is' : 'are'} excluded by default. Include{' '}
          {weakCount === 1 ? 'it' : 'them'} only if you recognise the sessions.
        </p>
      ) : null}

      {scan.projects.map((p) => (
        <ProjectCard
          key={p.project.id}
          project={p}
          selected={selected}
          onArtifactChange={setArtifactSelected}
          homeDir={homeDir}
          showEphemeral={showEphemeral}
        />
      ))}

      {scan.global.length > 0 ? (
        <>
          <SectionLabel className="mt-2">Global Claude Code Environment</SectionLabel>
          <Panel
            testId="review-global"
            title="User-wide state"
            description="Settings, memory, plugins, prompt history and the ~/.claude.json entries for the selected projects. Restored by merging — never by replacing your existing files."
            padded={false}
          >
            <div className="divide-y divide-border px-4">
              {providerResultsSorted(scan.global, providerRank).map((r) => (
                <ProviderSection
                  key={r.providerId}
                  result={r}
                  selected={selected}
                  onArtifactChange={setArtifactSelected}
                  homeDir={homeDir}
                  showEphemeral={showEphemeral}
                  testId={`review-global-${r.providerId}`}
                />
              ))}
            </div>
          </Panel>
        </>
      ) : null}
    </WizardPage>
  )
}

function ProjectCard({
  project,
  selected,
  onArtifactChange,
  homeDir,
  showEphemeral,
}: {
  project: ProjectScanResult
  selected: ReadonlySet<string>
  onArtifactChange: (id: string, checked: boolean) => void
  homeDir: string | null
  showEphemeral: boolean
}): React.JSX.Element {
  const git = project.project.git
  const selectedBytes = project.providers
    .flatMap((r) => r.artifacts)
    .filter((a) => selected.has(a.id))
    .reduce((n, a) => n + (a.sizeBytes ?? 0), 0)
  const weak = project.providers.flatMap((r) => r.artifacts.filter(needsReview)).length
  return (
    <Panel
      testId={`review-project-${project.project.id}`}
      padded={false}
      title={
        <span className="flex items-center gap-2">
          {project.project.name}
          {git?.branch ? (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] font-normal text-fg-muted">
              <GitBranch className="size-3" aria-hidden />
              {git.branch}
              {git.head ? ` @ ${git.head.slice(0, 7)}` : ''}
            </span>
          ) : null}
          {weak > 0 ? <Badge tone="warn">Needs review</Badge> : null}
        </span>
      }
      description={<PathText path={project.project.canonicalPath} homeDir={homeDir} />}
      actions={
        <span className="font-mono text-[12px] text-fg-muted tabular-nums">
          {formatBytes(selectedBytes)}
        </span>
      }
    >
      <WarningList warnings={project.warnings} variant="inset" />
      <div className="divide-y divide-border px-4">
        {providerResultsSorted(project.providers, providerRank).map((r) => (
          <ProviderSection
            key={r.providerId}
            result={r}
            selected={selected}
            onArtifactChange={onArtifactChange}
            homeDir={homeDir}
            showEphemeral={showEphemeral}
            testId={`review-${project.project.id}-${r.providerId}`}
          />
        ))}
      </div>
      <p className="sr-only">
        {project.providers
          .map((r) => `${providerLabel(r.providerId)}: ${r.detected ? 'detected' : 'not detected'}`)
          .join(', ')}
      </p>
    </Panel>
  )
}
