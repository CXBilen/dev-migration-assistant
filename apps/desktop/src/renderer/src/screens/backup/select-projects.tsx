import { FolderGit2, Plus, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import { getApi } from '../../api'
import { WizardPage } from '../../components/wizard-page'
import { Button } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { ErrorPanel } from '../../components/ui/error-panel'
import { PathText } from '../../components/ui/path-text'
import { useAsyncAction } from '../../hooks/use-async'
import { useHomeDir } from '../../hooks/use-home-dir'
import { basename } from '../../lib/paths'
import { plural } from '../../lib/format'
import { ROUTES } from '../../lib/routes'
import { useBackupWizard } from '../../stores/backup-wizard'

export function SelectProjectsScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir, defaultProjectsDir } = useHomeDir()
  const selectedPaths = useBackupWizard((s) => s.selectedPaths)
  const addPaths = useBackupWizard((s) => s.addPaths)
  const removePath = useBackupWizard((s) => s.removePath)
  const setScanJob = useBackupWizard((s) => s.setScanJob)
  const setScan = useBackupWizard((s) => s.setScan)

  const add = useAsyncAction(async () => {
    const res = await getApi().projects.selectDirectories({
      title: 'Choose project folders',
      defaultPath: defaultProjectsDir ?? undefined,
    })
    if (!res.cancelled) addPaths(res.paths)
  })

  const scan = useAsyncAction(async () => {
    const res = await getApi().projects.scan({ paths: selectedPaths, includeGlobal: true })
    setScan(null)
    setScanJob(res.jobId)
    void navigate(ROUTES.backupScan)
  })

  const error = add.error ?? scan.error

  return (
    <WizardPage
      title="Select Projects"
      description="Choose the project folders to migrate. Git repositories, Claude Code sessions and local files are detected automatically in the next step."
      backTo={ROUTES.home}
      testId="screen-projects"
      narrow
      footerStart={
        selectedPaths.length > 0
          ? plural(selectedPaths.length, 'project') + ' selected'
          : 'No projects selected yet'
      }
      footerEnd={
        <Button
          variant="primary"
          onClick={() => void scan.run()}
          disabled={selectedPaths.length === 0}
          loading={scan.pending}
          data-testid="projects-continue"
        >
          Continue
        </Button>
      }
    >
      {error ? <ErrorPanel error={error} /> : null}
      {selectedPaths.length === 0 ? (
        <EmptyState
          icon={<FolderGit2 />}
          title="No projects yet"
          description="Add the folders you work in. Worktrees that belong to a repository are picked up automatically."
          testId="projects-empty"
          action={
            <Button
              variant="primary"
              onClick={() => void add.run()}
              loading={add.pending}
              data-testid="projects-add"
            >
              <Plus className="size-4" aria-hidden />
              Add Project
            </Button>
          }
        />
      ) : (
        <>
          <ul
            className="divide-y divide-border rounded-panel bg-panel shadow-panel"
            aria-label="Selected projects"
            data-testid="projects-list"
          >
            {selectedPaths.map((p, index) => (
              <li
                key={p}
                className="flex items-center gap-3 px-4 py-2.5"
                data-testid={`projects-item-${index}`}
              >
                <FolderGit2 className="size-4 shrink-0 text-fg-muted" aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-medium">{basename(p) || p}</span>
                  <PathText path={p} homeDir={homeDir} />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 px-0 text-fg-muted"
                  onClick={() => removePath(p)}
                  aria-label={`Remove ${basename(p) || p}`}
                  data-testid={`projects-remove-${index}`}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <div>
            <Button onClick={() => void add.run()} loading={add.pending} data-testid="projects-add">
              <Plus className="size-4" aria-hidden />
              Add Project
            </Button>
          </div>
        </>
      )}
    </WizardPage>
  )
}
