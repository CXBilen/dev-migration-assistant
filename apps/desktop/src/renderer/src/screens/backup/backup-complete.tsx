import { FolderOpen, ShieldCheck } from 'lucide-react'
import { useNavigate } from 'react-router'
import { getApi } from '../../api'
import { WarningList } from '../../components/warning-list'
import { WizardPage } from '../../components/wizard-page'
import { Button } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { ErrorPanel } from '../../components/ui/error-panel'
import { KeyValueList } from '../../components/ui/key-value'
import { Panel } from '../../components/ui/panel'
import { PathText } from '../../components/ui/path-text'
import { useAsyncAction } from '../../hooks/use-async'
import { useHomeDir } from '../../hooks/use-home-dir'
import { formatBytes, formatDuration, formatNumber } from '../../lib/format'
import { basename } from '../../lib/paths'
import { ROUTES } from '../../lib/routes'
import { useBackupWizard } from '../../stores/backup-wizard'

export function BackupCompleteScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir } = useHomeDir()
  const result = useBackupWizard((s) => s.result)
  const setPassword = useBackupWizard((s) => s.setPassword)
  const setPasswordConfirm = useBackupWizard((s) => s.setPasswordConfirm)
  const reveal = useAsyncAction(async () => {
    if (result) await getApi().system.openInFinder(result.outputPath)
  })

  // No redirect here: a finished wizard's state may be cleared while this screen is still mounted.
  if (!result)
    return (
      <WizardPage title="No backup to show" testId="backup-complete-empty" narrow>
        <EmptyState
          icon={<ShieldCheck />}
          title="This backup run has ended"
          description="Start a new backup from Home to create another encrypted .devbackup."
          action={
            <Button variant="primary" onClick={() => void navigate(ROUTES.home)}>
              Back to Home
            </Button>
          }
        />
      </WizardPage>
    )

  const { manifest } = result
  return (
    <WizardPage
      title={result.verified ? 'Backup verified' : 'Backup written'}
      description="The file was re-read after writing and every chunk and checksum matched."
      testId="backup-complete"
      narrow
      footerEnd={
        <>
          <Button
            onClick={() => void reveal.run()}
            loading={reveal.pending}
            data-testid="backup-show-in-finder"
          >
            <FolderOpen className="size-4" aria-hidden />
            Show in Finder
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              // Drop the password immediately; Home resets the rest of the wizard on arrival.
              setPassword('')
              setPasswordConfirm('')
              void navigate(ROUTES.home)
            }}
            data-testid="backup-done"
          >
            Done
          </Button>
        </>
      }
    >
      {reveal.error ? <ErrorPanel error={reveal.error} /> : null}
      <Panel>
        <div className="flex items-start gap-4">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-ok-soft text-ok">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className="selectable text-[15px] font-semibold break-all"
              data-testid="backup-file-name"
            >
              {basename(result.outputPath)}
            </p>
            <PathText path={result.outputPath} homeDir={homeDir} />
            <KeyValueList
              className="mt-4"
              items={[
                {
                  key: 'Projects',
                  value: formatNumber(manifest.stats.projectCount),
                  testId: 'backup-projects-count',
                },
                {
                  key: 'Claude Code sessions',
                  value: formatNumber(manifest.stats.claudeSessionCount),
                  testId: 'backup-sessions-count',
                },
                {
                  key: 'Worktrees',
                  value: formatNumber(manifest.stats.worktreeCount),
                  testId: 'backup-worktrees-count',
                },
                { key: 'Items', value: formatNumber(manifest.stats.artifactCount) },
                {
                  key: 'Size',
                  value: `${formatBytes(result.sizeBytes)} (encrypted) · ${formatBytes(manifest.stats.payloadBytes)} payload`,
                  testId: 'backup-size',
                },
                { key: 'Label', value: manifest.label },
                { key: 'Took', value: formatDuration(result.durationMs) },
              ]}
            />
          </div>
        </div>
      </Panel>
      {result.warnings.length > 0 ? (
        <Panel title="Warnings" testId="backup-warnings">
          <WarningList warnings={result.warnings} variant="plain" className="text-[13px]" />
        </Panel>
      ) : null}
      <p className="text-[12.5px] text-fg-muted">
        Keep the password somewhere safe — it is not stored anywhere and cannot be recovered. On the
        destination Mac, open Dev Migration Assistant and choose{' '}
        <strong className="font-medium text-fg">Restore Backup</strong>.
      </p>
    </WizardPage>
  )
}
