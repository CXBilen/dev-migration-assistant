import { Archive, LockKeyhole } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { getApi } from '../../api'
import { WizardPage } from '../../components/wizard-page'
import { Button } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { ErrorPanel } from '../../components/ui/error-panel'
import { KeyValueList } from '../../components/ui/key-value'
import { Panel } from '../../components/ui/panel'
import { PasswordField } from '../../components/ui/password-field'
import { PathText } from '../../components/ui/path-text'
import { useAsyncAction } from '../../hooks/use-async'
import { useHomeDir } from '../../hooks/use-home-dir'
import { formatBytes, formatDateTime } from '../../lib/format'
import { basename } from '../../lib/paths'
import { ROUTES } from '../../lib/routes'
import { useRestoreWizard } from '../../stores/restore-wizard'

export function RestoreOpenScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir } = useHomeDir()
  const backupPath = useRestoreWizard((s) => s.backupPath)
  const headerInfo = useRestoreWizard((s) => s.headerInfo)
  const password = useRestoreWizard((s) => s.password)
  const setBackupPath = useRestoreWizard((s) => s.setBackupPath)
  const setHeaderInfo = useRestoreWizard((s) => s.setHeaderInfo)
  const setPassword = useRestoreWizard((s) => s.setPassword)
  const setInspection = useRestoreWizard((s) => s.setInspection)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const select = useAsyncAction(async () => {
    const res = await getApi().backups.selectFile()
    if (res.cancelled || !res.path) return
    setBackupPath(res.path)
    setPasswordError(null)
    const header = await getApi().backups.readHeader({ path: res.path })
    setHeaderInfo(header)
  })

  const unlock = useAsyncAction(async () => {
    if (!backupPath) return
    setPasswordError(null)
    try {
      const inspection = await getApi().backups.inspect({ path: backupPath, password })
      setInspection(inspection)
      void navigate(ROUTES.restoreContents)
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code === 'ARCHIVE_AUTH_FAILED') {
        setPasswordError('That password did not unlock this backup.')
        return
      }
      throw err
    }
  })

  const unsupported = headerInfo !== null && !headerInfo.supported
  const canUnlock =
    backupPath !== null &&
    headerInfo !== null &&
    !unsupported &&
    password.length > 0 &&
    !unlock.pending

  return (
    <WizardPage
      title="Restore a backup"
      description="Choose a .devbackup file. Nothing is written until you approve the restore plan."
      backTo={ROUTES.home}
      testId="screen-restore-open"
      narrow
      footerEnd={
        <Button
          variant="primary"
          onClick={() => void unlock.run()}
          disabled={!canUnlock}
          loading={unlock.pending}
          data-testid="restore-unlock"
        >
          <LockKeyhole className="size-4" aria-hidden />
          Unlock
        </Button>
      }
    >
      {select.error ? <ErrorPanel error={select.error} /> : null}
      {unlock.error ? <ErrorPanel error={unlock.error} /> : null}

      {!backupPath ? (
        <EmptyState
          icon={<Archive />}
          title="No backup selected"
          description="Backups are single encrypted files ending in .devbackup."
          testId="restore-empty"
          action={
            <Button
              variant="primary"
              onClick={() => void select.run()}
              loading={select.pending}
              data-testid="restore-select-file"
            >
              Choose .devbackup…
            </Button>
          }
        />
      ) : (
        <Panel
          title={
            <span className="selectable break-all" data-testid="restore-file-name">
              {basename(backupPath)}
            </span>
          }
          description={<PathText path={backupPath} homeDir={homeDir} />}
          actions={
            <Button
              size="sm"
              onClick={() => void select.run()}
              loading={select.pending}
              data-testid="restore-select-file"
            >
              Choose another…
            </Button>
          }
          testId="restore-header"
        >
          {headerInfo ? (
            <KeyValueList
              items={[
                { key: 'Size', value: formatBytes(headerInfo.sizeBytes) },
                {
                  key: 'Format version',
                  value: (
                    <span data-testid="restore-format-version">
                      {headerInfo.formatVersion}
                      {unsupported ? (
                        <span className="ml-2 text-danger">not supported by this app</span>
                      ) : null}
                    </span>
                  ),
                },
                { key: 'Cipher', value: headerInfo.cipher },
                {
                  key: 'Key derivation',
                  value: (
                    <span data-testid="restore-kdf">
                      {headerInfo.kdf.algorithm} · {Math.round(headerInfo.kdf.memoryKiB / 1024)} MiB
                      · {headerInfo.kdf.iterations} iterations · p=
                      {headerInfo.kdf.parallelism}
                    </span>
                  ),
                },
                { key: 'Created', value: formatDateTime(headerInfo.createdAt) },
              ]}
            />
          ) : (
            <p className="text-[13px] text-fg-muted">Reading header…</p>
          )}
        </Panel>
      )}

      {backupPath && headerInfo ? (
        unsupported ? (
          <ErrorPanel
            testId="restore-unsupported"
            error={{
              code: 'ARCHIVE_UNSUPPORTED_VERSION',
              message: `This backup uses format version ${headerInfo.formatVersion}; this app reads version 1.`,
              hint: 'Update Dev Migration Assistant to a release that supports this format, or create the backup again with this version.',
              recoverable: true,
            }}
          />
        ) : (
          <Panel
            title="Password"
            description="The password chosen when the backup was created. Wrong passwords are rejected before any payload is read."
            testId="restore-password-panel"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (canUnlock) void unlock.run()
              }}
            >
              <PasswordField
                id="restore-password"
                label="Backup password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  if (passwordError) setPasswordError(null)
                }}
                error={passwordError ?? undefined}
                data-testid="restore-password"
                autoFocus
              />
              <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
                Unlock
              </button>
            </form>
          </Panel>
        )
      ) : null}
    </WizardPage>
  )
}
