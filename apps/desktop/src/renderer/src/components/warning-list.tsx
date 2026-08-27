import { cn } from '../lib/cn'
import { StatusIcon } from './ui/status-icon'

export type WarningListVariant = 'panel' | 'inset' | 'plain'

/**
 * Warnings from a scan, plan or restore result, each with the warning glyph so colour is never
 * the only signal. Renders nothing when there is nothing to say.
 */
export function WarningList({
  warnings,
  variant = 'panel',
  className,
  testId,
}: {
  warnings: string[]
  /** panel: standalone soft-yellow block · inset: row inside a Panel · plain: bare list. */
  variant?: WarningListVariant
  className?: string
  testId?: string
}): React.JSX.Element | null {
  if (warnings.length === 0) return null
  return (
    <ul
      role="status"
      data-testid={testId}
      className={cn(
        'flex flex-col gap-1 text-warn',
        variant === 'panel' && 'rounded-panel bg-warn-soft px-4 py-3 text-[13px]',
        variant === 'inset' && 'border-b border-border px-4 py-2 text-[12px]',
        variant === 'plain' && 'text-[12.5px]',
        className,
      )}
    >
      {warnings.map((w, i) => (
        <li key={`${w}-${i}`} className="flex items-start gap-2">
          <StatusIcon status="warn" className="mt-px size-3.5" />
          <span className="min-w-0">{w}</span>
        </li>
      ))}
    </ul>
  )
}
