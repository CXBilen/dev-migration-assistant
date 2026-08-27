import type { ChecklistStatus } from '../lib/phases'
import { cn } from '../lib/cn'
import { StatusIcon } from './ui/status-icon'

export interface ProgressChecklistItem {
  id: string
  label: string
  status: ChecklistStatus
  detail?: string
}

/** Vertical checklist with semantic status glyphs. Announces changes politely. */
export function ProgressChecklist({
  items,
  title,
  className,
  testId,
  dense = false,
}: {
  items: ProgressChecklistItem[]
  title?: React.ReactNode
  className?: string
  testId?: string
  dense?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col', className)} data-testid={testId}>
      {title ? <p className="mb-1.5 text-[12px] font-semibold text-fg-muted">{title}</p> : null}
      <ol className={cn('flex flex-col', dense ? 'gap-1' : 'gap-1.5')} aria-live="polite">
        {items.map((item) => (
          <li
            key={item.id}
            data-testid={`checklist-${item.id}`}
            data-status={item.status}
            className={cn(
              'flex items-center gap-2.5 text-[13px]',
              item.status === 'pending' && 'text-fg-faint',
              item.status === 'skipped' && 'text-fg-faint line-through decoration-fg-faint/60',
            )}
          >
            <StatusIcon status={item.status} />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.detail ? (
              <span className="truncate text-[12px] text-fg-muted">{item.detail}</span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}
