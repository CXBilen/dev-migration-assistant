import type { ManifestArtifact, ManifestProject } from '@devmig/model'
import { GitBranch, Laptop } from 'lucide-react'
import { Navigate, useNavigate } from 'react-router'
import { WizardPage } from '../../components/wizard-page'
import { SensitivityBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Checkbox } from '../../components/ui/checkbox'
import { KeyValueList } from '../../components/ui/key-value'
import { Panel, SectionLabel } from '../../components/ui/panel'
import { PathText } from '../../components/ui/path-text'
import { Switch } from '../../components/ui/switch'
import { isSessionsArtifact, providerLabel, providerRank } from '../../lib/artifacts'
import { formatBytes, formatDateTime, formatNumber, plural } from '../../lib/format'
import { ROUTES } from '../../lib/routes'
import { useRestoreWizard } from '../../stores/restore-wizard'

export function RestoreContentsScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const inspection = useRestoreWizard((s) => s.inspection)
  const selected = useRestoreWizard((s) => s.selectedArtifactIds)
  const setArtifactSelected = useRestoreWizard((s) => s.setArtifactSelected)
  const includeGlobal = useRestoreWizard((s) => s.includeGlobal)
  const setIncludeGlobal = useRestoreWizard((s) => s.setIncludeGlobal)

  if (!inspection) return <Navigate to={ROUTES.restore} replace />

  const { manifest } = inspection
  const machine = manifest.machine
  const selectedCount = selected.size
  const selectedBytes = [
    ...manifest.projects.flatMap((p) => p.providers.flatMap((s) => s.artifacts)),
    ...manifest.global.flatMap((s) => s.artifacts),
  ]
    .filter((a) => selected.has(a.id))
    .reduce((n, a) => n + a.sizeBytes, 0)

  return (
    <WizardPage
      title="Backup contents"
      description={`“${manifest.label}” — created ${formatDateTime(manifest.createdAt)} with Dev Migration Assistant ${manifest.appVersion}.`}
      backTo={ROUTES.restore}
      testId="screen-restore-contents"
      footerStart={
        <span data-testid="contents-summary">
          {plural(selectedCount, 'item')} · {formatBytes(selectedBytes)}
        </span>
      }
      footerEnd={
        <Button
          variant="primary"
          onClick={() => void navigate(ROUTES.restoreMapping)}
          disabled={selectedCount === 0}
          data-testid="contents-continue"
        >
          Continue
        </Button>
      }
    >
      <Panel
        testId="contents-machine"
        title={
          <span className="flex items-center gap-2">
            <Laptop className="size-4 text-fg-muted" aria-hidden />
            Created on {machine.machineLabel ?? 'another Mac'}
          </span>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <KeyValueList
            items={[
              {
                key: 'Platform',
                value: `${machine.platform} · ${machine.arch}${machine.osVersion ? ` · macOS ${machine.osVersion}` : ''}`,
              },
              { key: 'User', value: `${machine.userName} (${machine.homeDir})` },
              { key: 'Captured', value: formatDateTime(machine.capturedAt) },
              {
                key: 'Totals',
                value: `${plural(manifest.stats.projectCount, 'project')} · ${formatNumber(manifest.stats.claudeSessionCount)} sessions · ${plural(manifest.stats.worktreeCount, 'worktree')}`,
              },
            ]}
          />
          <div>
            <p className="mb-1 text-[12px] font-medium text-fg-muted">Tool versions</p>
            <ul className="flex flex-col gap-0.5 text-[13px]" data-testid="contents-tools">
              {machine.tools.map((t) => (
                <li key={t.id} className="flex justify-between gap-3">
                  <span>{t.label}</span>
                  <span className="font-mono text-[12px] text-fg-muted">
                    {t.installed ? (t.version ?? 'installed') : 'not installed'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>

      {manifest.projects.map((p) => (
        <ProjectContents
          key={p.id}
          project={p}
          selected={selected}
          onChange={setArtifactSelected}
          homeDir={machine.homeDir}
        />
      ))}

      {manifest.global.length > 0 ? (
        <>
          <SectionLabel className="mt-2">Global Claude Code Environment</SectionLabel>
          <Panel
            testId="contents-global"
            title={
              <label
                htmlFor="contents-include-global"
                className="flex cursor-pointer items-center gap-3"
              >
                <Switch
                  id="contents-include-global"
                  checked={includeGlobal}
                  onCheckedChange={setIncludeGlobal}
                  data-testid="contents-include-global"
                />
                Restore user-wide settings, memory, plugins and history
              </label>
            }
            description="Merged into your existing ~/.claude — existing files are kept and reported as collisions in the plan."
            padded={false}
          >
            {includeGlobal ? (
              <div className="divide-y divide-border px-4">
                {[...manifest.global]
                  .sort((a, b) => providerRank(a.providerId) - providerRank(b.providerId))
                  .map((section) => (
                    <div key={section.providerId} className="py-2">
                      <p className="text-[12px] font-semibold text-fg-muted">
                        {providerLabel(section.providerId)}
                      </p>
                      {section.artifacts.map((a) => (
                        <ArtifactLine
                          key={a.id}
                          artifact={a}
                          checked={selected.has(a.id)}
                          onChange={(v) => setArtifactSelected(a.id, v)}
                          homeDir={machine.homeDir}
                        />
                      ))}
                    </div>
                  ))}
              </div>
            ) : (
              <p className="px-4 py-3 text-[12.5px] text-fg-faint">
                Not included. Turn the switch on to review the individual items.
              </p>
            )}
          </Panel>
        </>
      ) : null}
    </WizardPage>
  )
}

function ProjectContents({
  project,
  selected,
  onChange,
  homeDir,
}: {
  project: ManifestProject
  selected: ReadonlySet<string>
  onChange: (id: string, checked: boolean) => void
  homeDir: string
}): React.JSX.Element {
  const artifacts = project.providers.flatMap((s) => s.artifacts)
  const sessions = artifacts.filter(isSessionsArtifact).reduce((n, a) => n + (a.fileCount ?? 0), 0)
  const worktrees = project.git?.worktrees.filter((w) => !w.isPrimary).length ?? 0
  const allSelected = artifacts.every((a) => selected.has(a.id))
  const noneSelected = artifacts.every((a) => !selected.has(a.id))
  return (
    <Panel
      testId={`contents-project-${project.id}`}
      padded={false}
      title={
        <span className="flex items-center gap-2">
          <Checkbox
            checked={allSelected ? true : noneSelected ? false : 'indeterminate'}
            onCheckedChange={(v) => {
              for (const a of artifacts) onChange(a.id, v === true)
            }}
            aria-label={`Select all items of ${project.name}`}
            data-testid={`contents-project-toggle-${project.id}`}
          />
          {project.name}
          {project.git?.branch ? (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] font-normal text-fg-muted">
              <GitBranch className="size-3" aria-hidden />
              {project.git.branch}
            </span>
          ) : null}
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-3">
          <span>
            Previously at <PathText path={project.canonicalPath} homeDir={homeDir} />
          </span>
          <span>
            {formatNumber(sessions)} sessions · {plural(worktrees, 'worktree')} ·{' '}
            {plural(artifacts.length, 'item')}
          </span>
        </span>
      }
    >
      <div className="divide-y divide-border px-4">
        {[...project.providers]
          .sort((a, b) => providerRank(a.providerId) - providerRank(b.providerId))
          .map((section) => (
            <div key={section.providerId} className="py-2">
              <p className="text-[12px] font-semibold text-fg-muted">
                {providerLabel(section.providerId)}
              </p>
              {section.artifacts.map((a) => (
                <ArtifactLine
                  key={a.id}
                  artifact={a}
                  checked={selected.has(a.id)}
                  onChange={(v) => onChange(a.id, v)}
                  homeDir={homeDir}
                />
              ))}
            </div>
          ))}
      </div>
    </Panel>
  )
}

function ArtifactLine({
  artifact,
  checked,
  onChange,
  homeDir,
}: {
  artifact: ManifestArtifact
  checked: boolean
  onChange: (checked: boolean) => void
  homeDir: string
}): React.JSX.Element {
  const id = `restore-artifact-${artifact.id.replace(/[^A-Za-z0-9_-]/g, '_')}`
  return (
    <div className="flex items-start gap-3 py-1.5" data-testid={`restore-artifact-${artifact.id}`}>
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        aria-label={artifact.label}
        data-testid={`restore-artifact-checkbox-${artifact.id}`}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="cursor-pointer text-[13px]">
            {artifact.label}
          </label>
          <SensitivityBadge sensitivity={artifact.sensitivity} />
        </span>
        {artifact.sourcePath ? (
          <PathText path={artifact.sourcePath} homeDir={homeDir} className="text-[11px]" />
        ) : null}
      </div>
      <span className="shrink-0 font-mono text-[12px] text-fg-muted tabular-nums">
        {artifact.fileCount !== undefined ? `${formatNumber(artifact.fileCount)} · ` : ''}
        {formatBytes(artifact.sizeBytes)}
      </span>
    </div>
  )
}
