import type { ProviderScanResult } from '@devmig/model'
import { FileText, FolderGit2, MessagesSquare, Package } from 'lucide-react'
import { providerLabel } from '../lib/artifacts'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/format'
import { ArtifactRow } from './artifact-row'
import { SummaryList } from './summary-list'
import { WarningList } from './warning-list'

export function ProviderIcon({
  providerId,
  className,
}: {
  providerId: string
  className?: string
}): React.JSX.Element {
  const cls = cn('size-4 text-fg-muted', className)
  switch (providerId) {
    case 'git':
      return <FolderGit2 className={cls} aria-hidden />
    case 'claude-code':
      return <MessagesSquare className={cls} aria-hidden />
    case 'project-files':
      return <FileText className={cls} aria-hidden />
    default:
      return <Package className={cls} aria-hidden />
  }
}

/** One provider inside a project card: summary lines then selectable artifacts. */
export function ProviderSection({
  result,
  selected,
  onArtifactChange,
  homeDir,
  showEphemeral,
  testId,
}: {
  result: ProviderScanResult
  selected: ReadonlySet<string>
  onArtifactChange: (id: string, checked: boolean) => void
  homeDir?: string | null
  showEphemeral: boolean
  testId?: string
}): React.JSX.Element {
  const artifacts = result.artifacts.filter((a) => showEphemeral || a.scope !== 'ephemeral')
  const selectedBytes = artifacts
    .filter((a) => selected.has(a.id))
    .reduce((n, a) => n + (a.sizeBytes ?? 0), 0)
  return (
    <section
      className="py-3"
      data-testid={testId}
      aria-labelledby={`${testId ?? result.providerId}-title`}
    >
      <div className="flex items-center gap-2">
        <ProviderIcon providerId={result.providerId} />
        <h4 id={`${testId ?? result.providerId}-title`} className="text-[13px] font-semibold">
          {providerLabel(result.providerId)}
        </h4>
        {!result.detected ? (
          <span className="text-[12px] text-fg-faint">— nothing detected</span>
        ) : null}
        {artifacts.length > 0 ? (
          <span className="ml-auto font-mono text-[12px] text-fg-muted tabular-nums">
            {formatBytes(selectedBytes)} selected
          </span>
        ) : null}
      </div>
      <SummaryList items={result.summary} className="mt-2" />
      <WarningList warnings={result.warnings} variant="plain" className="mt-2 text-[12px]" />
      {artifacts.length > 0 ? (
        <div className="mt-2 divide-y divide-border rounded-control bg-panel-2 px-3">
          {artifacts.map((a) => (
            <ArtifactRow
              key={a.id}
              artifact={a}
              checked={selected.has(a.id)}
              onCheckedChange={(checked) => onArtifactChange(a.id, checked)}
              homeDir={homeDir}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}
