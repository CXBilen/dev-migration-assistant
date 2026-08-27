import type { ScannedArtifact } from '@devmig/model'
import { Info } from 'lucide-react'
import { needsReview } from '../lib/artifacts'
import { cn } from '../lib/cn'
import { formatBytes, formatNumber } from '../lib/format'
import { Badge, SensitivityBadge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { PathText } from './ui/path-text'
import { Tooltip } from './ui/tooltip'

export interface ArtifactRowProps {
  artifact: ScannedArtifact
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  homeDir?: string | null
  /** Render as a plain read-only line (credentials list). */
  readOnly?: boolean
}

/** One selectable artifact: checkbox, label, count/size, sensitivity badge, reasons tooltip. */
export function ArtifactRow({
  artifact,
  checked,
  onCheckedChange,
  homeDir,
  readOnly = false,
}: ArtifactRowProps): React.JSX.Element {
  const id = `artifact-${artifact.id.replace(/[^A-Za-z0-9_-]/g, '_')}`
  const disabled = !artifact.selectable || readOnly
  const review = needsReview(artifact)
  const meta: string[] = []
  if (artifact.count !== undefined) meta.push(formatNumber(artifact.count))
  if (artifact.sizeBytes !== undefined) meta.push(formatBytes(artifact.sizeBytes))
  return (
    <div
      className={cn('flex items-start gap-3 py-2', disabled && 'opacity-70')}
      data-testid={`artifact-${artifact.id}`}
      data-checked={checked}
    >
      {readOnly ? (
        <span
          className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center text-fg-faint"
          aria-hidden
        >
          ○
        </span>
      ) : (
        <Checkbox
          id={id}
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={(v) => onCheckedChange(v === true)}
          aria-label={artifact.label}
          data-testid={`artifact-checkbox-${artifact.id}`}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label
            htmlFor={readOnly ? undefined : id}
            className={cn('text-[13px]', !disabled && 'cursor-pointer')}
          >
            {artifact.label}
          </label>
          <SensitivityBadge sensitivity={artifact.sensitivity} />
          {review ? (
            <Badge tone="warn" data-testid={`needs-review-${artifact.id}`}>
              Needs review
            </Badge>
          ) : null}
          {artifact.scope === 'ephemeral' ? <Badge tone="neutral">Ephemeral</Badge> : null}
          {artifact.reasons.length > 0 ? (
            <Tooltip
              content={
                <ul className="list-disc pl-3">
                  {artifact.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              }
            >
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded-full text-fg-faint hover:text-fg"
                aria-label={`Why: ${artifact.reasons.join('. ')}`}
              >
                <Info className="size-3.5" aria-hidden />
              </button>
            </Tooltip>
          ) : null}
        </div>
        {artifact.description ? (
          <p className="text-[12px] text-fg-muted">{artifact.description}</p>
        ) : null}
        {!artifact.selectable && artifact.reasons[0] ? (
          <p className="text-[12px] text-fg-faint">Not selectable — {artifact.reasons[0]}</p>
        ) : null}
        {artifact.sourcePath ? (
          <PathText path={artifact.sourcePath} homeDir={homeDir} className="text-[11px]" />
        ) : null}
      </div>
      {meta.length > 0 ? (
        <span className="shrink-0 pt-0.5 text-right font-mono text-[12px] text-fg-muted tabular-nums">
          {meta.join(' · ')}
        </span>
      ) : null}
    </div>
  )
}
