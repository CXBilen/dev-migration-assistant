import { cn } from '../lib/cn'
import type { ChecklistStatus } from '../lib/phases'
import { StatusIcon } from './ui/status-icon'

/** Horizontal phase indicator (Collecting → Packing → Encrypting → Verifying). No fake percentages. */
export function PhaseStrip({
  phases,
  className,
  testId = 'phase-strip',
}: {
  phases: { id: string; label: string; status: ChecklistStatus }[]
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <ol
      className={cn('flex flex-wrap items-center gap-x-1 gap-y-2', className)}
      data-testid={testId}
      aria-label="Phases"
    >
      {phases.map((p, i) => (
        <li
          key={p.id}
          className="flex items-center gap-1"
          data-status={p.status}
          data-testid={`phase-${p.id}`}
        >
          <span
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium',
              p.status === 'running' && 'bg-accent-soft text-fg',
              p.status === 'done' && 'text-fg-muted',
              p.status === 'pending' && 'text-fg-faint',
              p.status === 'failed' && 'bg-danger-soft text-danger',
              p.status === 'skipped' && 'text-fg-faint',
              p.status === 'warn' && 'bg-warn-soft text-warn',
            )}
            aria-current={p.status === 'running' ? 'step' : undefined}
          >
            <StatusIcon status={p.status} className="size-3.5" />
            {p.label}
          </span>
          {i < phases.length - 1 ? (
            <span className="text-fg-faint" aria-hidden>
              ›
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
