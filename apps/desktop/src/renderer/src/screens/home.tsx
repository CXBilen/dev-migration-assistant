import { ArchiveRestore, HardDriveDownload, Settings, Stethoscope } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { isMockApi } from '../api'
import { Badge } from '../components/ui/badge'
import { ROUTES } from '../lib/routes'
import { useBackupWizard } from '../stores/backup-wizard'
import { useRestoreWizard } from '../stores/restore-wizard'

export function HomeScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const resetBackup = useBackupWizard((s) => s.reset)
  const resetRestore = useRestoreWizard((s) => s.reset)
  const mock = isMockApi()

  return (
    <div className="flex min-h-0 flex-1 flex-col px-8 pb-6" data-testid="home">
      <div className="flex flex-1 flex-col justify-center">
        <div className="max-w-2xl">
          <p className="text-[12px] font-semibold tracking-[0.08em] text-fg-faint uppercase">
            Dev Migration Assistant
          </p>
          <h1 className="mt-2 text-[30px] leading-[1.15] font-semibold tracking-[-0.02em]">
            Move your development environment without losing your context.
          </h1>
          <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-fg-muted">
            Back up Claude Code sessions and settings, Git working trees and worktrees, and local
            environment files into one encrypted{' '}
            <code className="font-mono text-[13px]">.devbackup</code>. Restore it on another Mac
            with safe path remapping.
          </p>
          {mock ? (
            <Badge tone="accent" className="mt-3" data-testid="home-mock-badge">
              Preview data — the native bridge is not connected
            </Badge>
          ) : null}
        </div>

        <div className="mt-8 grid max-w-2xl grid-cols-2 gap-3">
          <ActionCard
            testId="home-create-backup"
            icon={<HardDriveDownload className="size-5" aria-hidden />}
            title="Create Backup"
            description="Pick projects, review what is included, encrypt with a password."
            onClick={() => {
              resetBackup()
              void navigate(ROUTES.backupProjects)
            }}
          />
          <ActionCard
            testId="home-restore-backup"
            icon={<ArchiveRestore className="size-5" aria-hidden />}
            title="Restore Backup"
            description="Open a .devbackup, choose locations, review the plan, then restore."
            onClick={() => {
              resetRestore()
              void navigate(ROUTES.restore)
            }}
          />
        </div>

        <div className="mt-6 flex items-center gap-4 text-[13px]">
          <Link
            to={ROUTES.diagnostics}
            className="inline-flex items-center gap-1.5 text-fg-muted hover:text-fg"
            data-testid="home-diagnostics"
          >
            <Stethoscope className="size-4" aria-hidden />
            Diagnostics
          </Link>
          <Link
            to={ROUTES.settings}
            className="inline-flex items-center gap-1.5 text-fg-muted hover:text-fg"
            data-testid="home-settings"
          >
            <Settings className="size-4" aria-hidden />
            Settings
          </Link>
        </div>
      </div>
      <footer className="pt-6 text-[12px] text-fg-faint" data-testid="home-footer">
        Local only · Encrypted · Open source
      </footer>
    </div>
  )
}

function ActionCard({
  icon,
  title,
  description,
  onClick,
  testId,
}: {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
  testId: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="group flex flex-col items-start gap-2 rounded-panel bg-panel p-4 text-left shadow-panel transition-colors hover:bg-panel-2"
    >
      <span className="inline-flex size-9 items-center justify-center rounded-[9px] bg-accent-soft text-accent">
        {icon}
      </span>
      <span className="text-[14px] font-semibold">{title}</span>
      <span className="text-[12.5px] leading-snug text-fg-muted">{description}</span>
    </button>
  )
}
