import { Check, Copy, ExternalLink, FileText, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { getApi } from '../api'
import { JobEventLog } from '../components/job-event-log'
import { WizardPage } from '../components/wizard-page'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/confirm-dialog'
import { ErrorPanel } from '../components/ui/error-panel'
import { KeyValueList } from '../components/ui/key-value'
import { Panel, SectionLabel } from '../components/ui/panel'
import { PasswordField } from '../components/ui/password-field'
import { PathText } from '../components/ui/path-text'
import { StatusIcon } from '../components/ui/status-icon'
import { useAsyncAction, useAsyncValue } from '../hooks/use-async'
import { useHomeDir } from '../hooks/use-home-dir'
import { useJob } from '../hooks/use-job'
import { formatBytes, formatDateTime, formatNumber } from '../lib/format'
import { parseJobResult } from '../lib/job-result'
import { basename } from '../lib/paths'
import { phaseLabel } from '../lib/phases'
import { ROUTES } from '../lib/routes'

const GITHUB_URL = 'https://github.com/CXBilen/dev-migration-assistant'

export function DiagnosticsScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir } = useHomeDir()
  const diag = useAsyncValue(() => getApi().system.diagnostics())
  const [copied, setCopied] = useState(false)
  const copy = useAsyncAction(async () => {
    await getApi().system.copyDiagnostics()
    setCopied(true)
  })
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])
  const openLogs = useAsyncAction(async () => {
    await getApi().system.openLogs()
  })
  const openGithub = useAsyncAction(async () => {
    await getApi().system.openExternal(GITHUB_URL)
  })

  // Verify a backup file: select → password prompt → verify job.
  const [verifyPath, setVerifyPath] = useState<string | null>(null)
  const [verifyPassword, setVerifyPassword] = useState('')
  const [verifyJobId, setVerifyJobId] = useState<string | null>(null)
  const verifyView = useJob(verifyJobId)
  const verifyResult = parseJobResult('verify', verifyView.snapshot ?? undefined)
  const pickFile = useAsyncAction(async () => {
    const res = await getApi().backups.selectFile()
    if (res.cancelled || !res.path) return
    setVerifyPassword('')
    setVerifyPath(res.path)
  })
  const startVerify = useAsyncAction(async () => {
    if (!verifyPath) return
    const res = await getApi().backups.verify({ path: verifyPath, password: verifyPassword })
    setVerifyJobId(res.jobId)
    setVerifyPath(null)
    setVerifyPassword('')
  })

  const d = diag.data
  return (
    <WizardPage
      title="Diagnostics"
      description="About this app, what it found on this Mac, and the tools to troubleshoot it."
      backTo={() => void navigate(ROUTES.home)}
      backLabel="Home"
      testId="screen-diagnostics"
      headerEnd={
        <div className="flex gap-2">
          <Button
            onClick={() => void openLogs.run()}
            loading={openLogs.pending}
            data-testid="diag-open-logs"
          >
            <FileText className="size-4" aria-hidden />
            Open logs
          </Button>
          <Button
            onClick={() => void copy.run()}
            loading={copy.pending}
            data-testid="diag-copy"
            aria-live="polite"
          >
            {copied ? (
              <Check className="size-4" aria-hidden />
            ) : (
              <Copy className="size-4" aria-hidden />
            )}
            {copied ? 'Copied' : 'Copy diagnostics report'}
          </Button>
        </div>
      }
    >
      {diag.error ? (
        <ErrorPanel
          error={diag.error}
          actions={
            <Button size="sm" onClick={diag.reload}>
              Retry
            </Button>
          }
        />
      ) : null}
      {copy.error ? <ErrorPanel error={copy.error} /> : null}
      {openLogs.error ? <ErrorPanel error={openLogs.error} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Application" testId="diag-app">
          <KeyValueList
            items={[
              {
                key: 'App version',
                value: d?.appVersion ?? getApi().meta.appVersion,
                testId: 'diag-app-version',
              },
              {
                key: 'Backup format',
                value: d ? `version ${d.backupFormatVersion}` : '—',
                testId: 'diag-format-version',
              },
              { key: 'Electron', value: d?.electronVersion ?? 'not running in Electron' },
              { key: 'Node', value: d?.nodeVersion ?? '—' },
              {
                key: 'Machine',
                value: d
                  ? `${d.machine.machineLabel ?? 'Mac'} · ${d.machine.platform} ${d.machine.arch}${d.machine.osVersion ? ` · macOS ${d.machine.osVersion}` : ''}`
                  : '—',
              },
              {
                key: 'Logs',
                value: d ? (
                  <PathText path={d.logsDirectory} homeDir={homeDir} className="text-fg" />
                ) : (
                  '—'
                ),
                testId: 'diag-logs-dir',
              },
              { key: 'Generated', value: d ? formatDateTime(d.generatedAt) : '—' },
            ]}
          />
        </Panel>
        <Panel title="Claude Code" testId="diag-claude">
          <KeyValueList
            items={[
              {
                key: 'Data directory',
                value: d ? (
                  <span className="flex flex-wrap items-center gap-2">
                    {d.claudeConfigDir ? (
                      <PathText path={d.claudeConfigDir} homeDir={homeDir} className="text-fg" />
                    ) : (
                      'not set'
                    )}
                    {d.claudeConfigDirExists ? (
                      <Badge tone="ok">exists</Badge>
                    ) : (
                      <Badge tone="warn">missing</Badge>
                    )}
                  </span>
                ) : (
                  '—'
                ),
                testId: 'diag-claude-dir',
              },
              {
                key: 'Claude Code',
                value: d ? (d.claudeCodeVersion ?? 'not installed') : '—',
                testId: 'diag-claude-version',
              },
              {
                key: 'Matching',
                value:
                  'Metadata-driven: transcript cwd evidence, directory-name encoding treated as a verified hypothesis.',
              },
            ]}
          />
        </Panel>
      </div>

      <SectionLabel className="mt-2">Providers</SectionLabel>
      <Panel padded={false} testId="diag-providers">
        <ul className="divide-y divide-border px-4">
          {(d?.providers ?? []).map((p) => (
            <li
              key={p.id}
              className="flex items-start gap-3 py-2.5"
              data-testid={`diag-provider-${p.id}`}
            >
              <StatusIcon status={p.available ? 'ok' : 'warn'} className="mt-0.5" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium">
                  {p.displayName}{' '}
                  <span className="font-mono text-[11px] font-normal text-fg-faint">
                    {p.version}
                  </span>
                </span>
                {Object.keys(p.details).length > 0 ? (
                  <span className="selectable font-mono text-[11.5px] text-fg-muted">
                    {Object.entries(p.details)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(' · ')}
                  </span>
                ) : null}
                {p.notes.map((n) => (
                  <span key={n} className="text-[12px] text-fg-muted">
                    {n}
                  </span>
                ))}
              </div>
              <span className="text-[12px] text-fg-muted">
                {p.available ? 'available' : 'unavailable'}
              </span>
            </li>
          ))}
          {!d && diag.loading ? (
            <li className="py-3 text-[12.5px] text-fg-faint">Loading…</li>
          ) : null}
        </ul>
      </Panel>

      <SectionLabel className="mt-2">Verify a backup</SectionLabel>
      <Panel
        title="Check a .devbackup without restoring it"
        description="Streams through the file, authenticating every encrypted chunk and comparing every checksum. Nothing is extracted."
        testId="diag-verify-panel"
        actions={
          <Button
            onClick={() => void pickFile.run()}
            loading={pickFile.pending}
            data-testid="diag-verify"
          >
            <ShieldCheck className="size-4" aria-hidden />
            Verify a backup file…
          </Button>
        }
      >
        {pickFile.error ? <ErrorPanel error={pickFile.error} /> : null}
        {startVerify.error ? <ErrorPanel error={startVerify.error} /> : null}
        {verifyJobId ? (
          <div className="flex flex-col gap-3" data-testid="diag-verify-result">
            <p className="flex items-center gap-2 text-[13px]" role="status" aria-live="polite">
              {verifyView.status === 'completed' && verifyResult ? (
                <>
                  <StatusIcon status={verifyResult.ok ? 'ok' : 'error'} />
                  {verifyResult.ok ? 'Backup verified' : 'Verification failed'} ·{' '}
                  {formatNumber(verifyResult.entries)} entries · {formatBytes(verifyResult.bytes)}
                </>
              ) : verifyView.status === 'failed' || verifyView.status === 'cancelled' ? (
                <>
                  <StatusIcon status="error" /> Verification did not complete
                </>
              ) : (
                <>
                  <StatusIcon status="running" /> {phaseLabel(verifyView.lastPhase)} —{' '}
                  {verifyView.snapshot?.message ?? 'Starting…'}
                </>
              )}
            </p>
            {verifyView.snapshot?.error ? <ErrorPanel error={verifyView.snapshot.error} /> : null}
            <JobEventLog
              events={verifyView.events}
              maxHeightClass="max-h-40"
              testId="diag-verify-log"
            />
          </div>
        ) : (
          <p className="text-[12.5px] text-fg-faint">No verification run yet.</p>
        )}
      </Panel>

      <SectionLabel className="mt-2">Open source</SectionLabel>
      <Panel testId="diag-about">
        <div className="flex flex-col gap-3 text-[13px]">
          <p>
            Dev Migration Assistant is open source under the MIT license. Everything runs locally:
            no account, no server, no telemetry, no cloud upload.
          </p>
          <p className="text-fg-muted">
            Architecture: React renderer → typed, zod-validated IPC → Electron main → provider-owned
            migration semantics (Claude Code, Git, project files, runtime) → encrypted{' '}
            <code className="font-mono text-[12px]">.devbackup</code> container (Argon2id, chunked
            AES-256-GCM, hardened extraction).
          </p>
          <div>
            <Button variant="link" onClick={() => void openGithub.run()} data-testid="diag-github">
              <ExternalLink className="size-3.5" aria-hidden />
              github.com/CXBilen/dev-migration-assistant
            </Button>
          </div>
        </div>
      </Panel>

      <Dialog
        open={verifyPath !== null}
        onOpenChange={(open) => {
          if (!open) {
            setVerifyPath(null)
            setVerifyPassword('')
          }
        }}
        title="Backup password"
        description={
          verifyPath
            ? `Needed to authenticate ${basename(verifyPath)}. The password is used once and not stored.`
            : undefined
        }
        testId="diag-verify-dialog"
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (verifyPassword.length > 0) void startVerify.run()
          }}
        >
          <PasswordField
            id="diag-verify-password"
            label="Password"
            value={verifyPassword}
            onChange={(e) => setVerifyPassword(e.target.value)}
            data-testid="diag-verify-password"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setVerifyPath(null)
                setVerifyPassword('')
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={verifyPassword.length === 0}
              loading={startVerify.pending}
              data-testid="diag-verify-start"
            >
              Verify
            </Button>
          </div>
        </form>
      </Dialog>
    </WizardPage>
  )
}
