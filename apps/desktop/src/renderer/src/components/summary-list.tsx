import type { SummaryItem } from '@devmig/model'
import { cn } from '../lib/cn'
import { StatusIcon } from './ui/status-icon'

/** Provider summary lines ("✓ main @ abc123", "! 4 modified files"). */
export function SummaryList({
  items,
  className,
}: {
  items: SummaryItem[]
  className?: string
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <ul className={cn('flex flex-col gap-1', className)}>
      {items.map((item, i) => (
        <li key={`${item.label}-${i}`} className="flex items-start gap-2 text-[12.5px]">
          <StatusIcon status={item.status} className="mt-px size-3.5" />
          <span className="min-w-0">
            <span
              className={cn(
                item.status === 'warn' && 'text-warn',
                item.status === 'error' && 'text-danger',
              )}
            >
              {item.label}
            </span>
            {item.detail ? <span className="text-fg-muted"> — {item.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}
