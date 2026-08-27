import type { ScannedArtifact } from '@devmig/model'
import { FolderOpen, Lock } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { getApi } from '../../api'
import { WizardPage } from '../../components/wizard-page'
import { Button } from '../../components/ui/button'
import { ErrorPanel } from '../../components/ui/error-panel'
import { Panel, SectionLabel } from '../../components/ui/panel'
import { PasswordField } from '../../components/ui/password-field'
import { PathText } from '../../components/ui/path-text'
import { StatusIcon } from '../../components/ui/status-icon'
import { Switch } from '../../components/ui/switch'
import { TextField } from '../../components/ui/text-field'
import { useAsyncAction } from '../../hooks/use-async'
import { useHomeDir } from '../../hooks/use-home-dir'
import { useShowEphemeral } from '../../hooks/use-prefs'
import { cn } from '../../lib/cn'
import { formatBytes, plural } from '../../lib/format'
import { MIN_PASSWORD_LENGTH, passwordStrength } from '../../lib/password'
import { ROUTES } from '../../lib/routes'
import { computeTotals, groupForSecurityReview } from '../../lib/totals'
import { useBackupWizard } from '../../stores/backup-wizard'

export const SENSITIVE_COPY =
  'These may contain API keys or tokens. Include them only in encrypted backups.'

export function SecurityReviewScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir } = useHomeDir()
  const [showEphemeral] = useShowEphemeral()
  const scan = useBackupWizard((s) => s.scan)
  const selected = useBackupWizard((s) => s.selectedArtifactIds)
  const setArtifactSelected = useBackupWizard((s) => s.setArtifactSelected)
  const password = useBackupWizard((s) => s.password)
  const passwordConfirm = useBackupWizard((s) => s.passwordConfirm)
  const setPassword = useBackupWizard((s) => s.setPassword)
  const setPasswordConfirm = useBackupWizard((s) => s.setPasswordConfirm)
  const label = useBackupWizard((s) => s.label)
  const setLabel = useBackupWizard((s) => s.setLabel)
  const outputPath = useBackupWizard((s) => s.outputPath)
  const setOutputPath = useBackupWizard((s) => s.setOutputPath)
  const setBackupJob = useBackupWizard((s) => s.setBackupJob)

  // Default label from the main process, but never overwrite what the user typed.
  useEffect(() => {
    let active = true
    getApi()
      .system.suggestBackupName()
      .then((res) => {
        if (!active) return
        if (useBackupWizard.getState().label === '') setLabel(res.name)
      })
      .catch(() => {
        /* the label field stays empty and is required, so nothing is lost */
      })
    return () => {
      active = false
    }
  }, [setLabel])

  const chooseOutput = useAsyncAction(async () => {
    const res = await getApi().backups.selectOutputPath({ suggestedName: label.trim() || 'backup' })
    if (!res.cancelled && res.path) setOutputPath(res.path)
  })

  const start = useAsyncAction(async () => {
    if (!scan || !outputPath) return
    const res = await getApi().backups.create({
      scanId: scan.id,
      selectedArtifactIds: [...selected],
      outputPath,
      password,
      label: label.trim(),
    })
    setBackupJob(res.jobId)
    void navigate(ROUTES.backupProgress)
  })

  const groups = useMemo(
    () => (scan ? groupForSecurityReview(scan, selected, showEphemeral) : null),
    [scan, selected, showEphemeral],
  )

  if (!scan || !groups) return <Navigate to={ROUTES.backupProjects} replace />

  const totals = computeTotals(scan, selected)
  const strength = passwordStrength(password)
  const confirmMismatch = passwordConfirm.length > 0 && passwordConfirm !== password
  const passwordOk = strength.acceptable && passwordConfirm === password
  const canStart =
    passwordOk &&
    outputPath !== null &&
    label.trim().length > 0 &&
    totals.artifacts > 0 &&
    !start.pending

  return (
    <WizardPage
      title="Security review"
      description="Decide what sensitive data travels with the backup, then choose a password. The file is encrypted with AES-256-GCM; the password is never stored."
      backTo={ROUTES.backupReview}
      testId="screen-security"
      footerStart={
        <span data-testid="security-summary">
          {plural(totals.artifacts, 'item')} · {formatBytes(totals.bytes)}
          {totals.sensitiveIncluded > 0
            ? ` · ${plural(totals.sensitiveIncluded, 'sensitive file')} included`
            : ' · no sensitive files'}
        </span>
      }
      footerEnd={
        <Button
          variant="primary"
          onClick={() => void start.run()}
          disabled={!canStart}
          loading={start.pending}
          data-testid="security-start"
        >
          <Lock className="size-4" aria-hidden />
          Create encrypted backup
        </Button>
      }
    >
      {start.error ? <ErrorPanel error={start.error} /> : null}
      {chooseOutput.error ? <ErrorPanel error={chooseOutput.error} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Group
            title="Included"
            count={groups.included.length}
            testId="security-included"
            empty="Nothing selected. Go back to the review step to include items."
          >
            {groups.included.map((a) => (
              <ReadOnlyLine key={a.id} artifact={a} status="ok" homeDir={homeDir} />
            ))}
          </Group>

          <Group
            title="Sensitive — opt in"
            count={groups.sensitive.length}
            testId="security-sensitive"
            description={SENSITIVE_COPY}
            empty="No sensitive files were detected."
          >
            {groups.sensitive.map((a) => (
              <SensitiveToggle
                key={a.id}
                artifact={a}
                checked={selected.has(a.id)}
                onChange={(v) => setArtifactSelected(a.id, v)}
                homeDir={homeDir}
              />
            ))}
          </Group>

          <Group
            title="Excluded"
            count={groups.excluded.length}
            testId="security-excluded"
            empty="Nothing is excluded."
            description="Deselected items and machine-local state. They are listed for transparency and are not written to the backup."
          >
            {groups.excluded.map((a) => (
              <ReadOnlyLine key={a.id} artifact={a} status="excluded" homeDir={homeDir} />
            ))}
          </Group>

          <Group
            title="Credentials — re-authentication required on the destination Mac"
            count={groups.credentials.length}
            testId="security-credentials"
            empty="No credentials were detected."
            description="Sign-in tokens and session keys are never migrated. You will sign in again after restoring."
          >
            {groups.credentials.map((a) => (
              <ReadOnlyLine key={a.id} artifact={a} status="excluded" homeDir={homeDir} />
            ))}
          </Group>
        </div>

        <div className="flex flex-col gap-4">
          <Panel
            title="Encryption"
            description="Argon2id key derivation, AES-256-GCM. Forgetting the password means the backup cannot be opened."
            testId="security-encryption"
          >
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (canStart) void start.run()
              }}
            >
              <PasswordField
                id="security-password"
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                hint={
                  <span
                    className="flex items-center gap-2"
                    data-testid="security-password-strength"
                    data-score={strength.score}
                  >
                    <StrengthMeter score={strength.score} />
                    {strength.label}
                  </span>
                }
                data-testid="security-password"
                autoFocus
              />
              <PasswordField
                id="security-password-confirm"
                label="Confirm password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                error={confirmMismatch ? 'Passwords do not match.' : undefined}
                data-testid="security-password-confirm"
              />
              <p className="text-[11.5px] text-fg-faint">
                Minimum {MIN_PASSWORD_LENGTH} characters. A passphrase of several words is easier to
                remember and stronger.
              </p>
              <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
                Create
              </button>
            </form>
          </Panel>

          <Panel title="Backup file" testId="security-file">
            <div className="flex flex-col gap-3">
              <TextField
                id="security-label"
                label="Label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={200}
                hint="Shown when the backup is opened."
                data-testid="security-label"
              />
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-fg-muted">Save to</span>
                <div className="flex items-start gap-2">
                  <div className="min-h-8 flex-1 rounded-control bg-panel-2 px-2.5 py-1.5 shadow-[0_0_0_1px_var(--border)]">
                    {outputPath ? (
                      <PathText path={outputPath} homeDir={homeDir} className="text-fg" />
                    ) : (
                      <span className="text-[12px] text-fg-faint">No location chosen</span>
                    )}
                    <span className="sr-only" data-testid="security-output-path">
                      {outputPath ?? ''}
                    </span>
                  </div>
                  <Button
                    onClick={() => void chooseOutput.run()}
                    loading={chooseOutput.pending}
                    data-testid="security-choose-output"
                  >
                    <FolderOpen className="size-4" aria-hidden />
                    Choose…
                  </Button>
                </div>
              </div>
            </div>
          </Panel>

          <ul
            className="flex flex-col gap-1.5 px-1 text-[12px] text-fg-muted"
            data-testid="security-checklist"
          >
            <Requirement
              ok={strength.acceptable}
              label={`Password has at least ${MIN_PASSWORD_LENGTH} characters`}
            />
            <Requirement
              ok={password.length > 0 && passwordConfirm === password}
              label="Passwords match"
            />
            <Requirement ok={label.trim().length > 0} label="Backup has a label" />
            <Requirement ok={outputPath !== null} label="Save location chosen" />
          </ul>
        </div>
      </div>
    </WizardPage>
  )
}

function Group({
  title,
  count,
  description,
  empty,
  children,
  testId,
}: {
  title: string
  count: number
  description?: string
  empty: string
  children: React.ReactNode
  testId: string
}): React.JSX.Element {
  return (
    <div data-testid={testId}>
      <SectionLabel className="mb-1.5">
        {title} <span className="font-normal text-fg-faint">· {count}</span>
      </SectionLabel>
      <Panel padded={false}>
        {description ? (
          <p className="border-b border-border px-4 py-2 text-[12.5px] text-fg-muted">
            {description}
          </p>
        ) : null}
        <div className="divide-y divide-border px-4">
          {count === 0 ? <p className="py-3 text-[12.5px] text-fg-faint">{empty}</p> : children}
        </div>
      </Panel>
    </div>
  )
}

function ReadOnlyLine({
  artifact,
  status,
  homeDir,
}: {
  artifact: ScannedArtifact
  status: 'ok' | 'excluded'
  homeDir: string | null
}): React.JSX.Element {
  const reason = artifact.reasons[0]
  return (
    <div className="flex items-start gap-3 py-2" data-testid={`security-item-${artifact.id}`}>
      <StatusIcon status={status} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn('text-[13px]', status === 'excluded' && 'text-fg-muted')}>
          {artifact.label}
        </span>
        {reason && status === 'excluded' ? (
          <span className="text-[12px] text-fg-faint">{reason}</span>
        ) : null}
        {artifact.sourcePath ? (
          <PathText path={artifact.sourcePath} homeDir={homeDir} className="text-[11px]" />
        ) : null}
      </div>
      {artifact.sizeBytes !== undefined && artifact.sizeBytes > 0 ? (
        <span className="shrink-0 font-mono text-[12px] text-fg-muted tabular-nums">
          {formatBytes(artifact.sizeBytes)}
        </span>
      ) : null}
    </div>
  )
}

function SensitiveToggle({
  artifact,
  checked,
  onChange,
  homeDir,
}: {
  artifact: ScannedArtifact
  checked: boolean
  onChange: (checked: boolean) => void
  homeDir: string | null
}): React.JSX.Element {
  const id = `sensitive-${artifact.id.replace(/[^A-Za-z0-9_-]/g, '_')}`
  return (
    <div
      className="flex items-start gap-3 py-2"
      data-testid={`security-sensitive-item-${artifact.id}`}
    >
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="mt-0.5"
        aria-label={`Include ${artifact.label}`}
        data-testid={`security-sensitive-${artifact.id}`}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <label htmlFor={id} className="cursor-pointer text-[13px]">
          {artifact.label}
          <span className="ml-2 text-[12px] text-fg-muted">
            {checked ? 'included (encrypted)' : 'excluded'}
          </span>
        </label>
        {artifact.reasons.length > 0 ? (
          <span className="text-[12px] text-fg-faint">{artifact.reasons.join(' · ')}</span>
        ) : null}
        {artifact.sourcePath ? (
          <PathText path={artifact.sourcePath} homeDir={homeDir} className="text-[11px]" />
        ) : null}
      </div>
      {artifact.sizeBytes !== undefined ? (
        <span className="shrink-0 font-mono text-[12px] text-fg-muted tabular-nums">
          {formatBytes(artifact.sizeBytes)}
        </span>
      ) : null}
    </div>
  )
}

function StrengthMeter({ score }: { score: number }): React.JSX.Element {
  return (
    <span className="inline-flex gap-0.5" aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 w-5 rounded-full bg-border-strong',
            i <= score && score <= 1 && 'bg-danger',
            i <= score && score === 2 && 'bg-warn',
            i <= score && score >= 3 && 'bg-ok',
          )}
        />
      ))}
    </span>
  )
}

function Requirement({ ok, label }: { ok: boolean; label: string }): React.JSX.Element {
  return (
    <li className="flex items-center gap-2">
      <StatusIcon status={ok ? 'ok' : 'pending'} className="size-3.5" />
      <span className={cn(ok && 'text-fg')}>{label}</span>
    </li>
  )
}
