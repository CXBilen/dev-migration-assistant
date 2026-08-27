import { Check, Circle, CircleAlert, CircleDashed, Minus, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Spinner } from './spinner'

export type StatusKind =
  | 'ok'
  | 'pass'
  | 'done'
  | 'warn'
  | 'partial'
  | 'error'
  | 'fail'
  | 'failed'
  | 'info'
  | 'excluded'
  | 'skipped'
  | 'pending'
  | 'running'

const LABELS: Record<StatusKind, string> = {
  ok: 'OK',
  pass: 'Passed',
  done: 'Done',
  warn: 'Warning',
  partial: 'Partially done',
  error: 'Error',
  fail: 'Failed',
  failed: 'Failed',
  info: 'Info',
  excluded: 'Excluded',
  skipped: 'Skipped',
  pending: 'Pending',
  running: 'In progress',
}

/**
 * Semantic status glyph: colour AND shape carry meaning (✓ ok, ! warn, ○ info/excluded, ✕ error).
 * Always announces its meaning to assistive technology via aria-label.
 */
export function StatusIcon({
  status,
  className,
  label,
}: {
  status: StatusKind
  className?: string
  label?: string
}): React.JSX.Element {
  const common = 'size-4 shrink-0'
  const aria = { role: 'img' as const, 'aria-label': label ?? LABELS[status] }
  switch (status) {
    case 'ok':
    case 'pass':
    case 'done':
      return (
        <span
          className={cn(
            'inline-flex size-4 items-center justify-center rounded-full bg-ok-soft text-ok',
            className,
          )}
          {...aria}
        >
          <Check className="size-3" strokeWidth={3} aria-hidden />
        </span>
      )
    case 'warn':
    case 'partial':
      return <TriangleAlert className={cn(common, 'text-warn', className)} {...aria} />
    case 'error':
    case 'fail':
    case 'failed':
      return (
        <span
          className={cn(
            'inline-flex size-4 items-center justify-center rounded-full bg-danger-soft text-danger',
            className,
          )}
          {...aria}
        >
          <X className="size-3" strokeWidth={3} aria-hidden />
        </span>
      )
    case 'info':
      return <CircleAlert className={cn(common, 'text-info', className)} {...aria} />
    case 'excluded':
    case 'skipped':
      return <Minus className={cn(common, 'text-fg-faint', className)} {...aria} />
    case 'pending':
      return (
        <Circle className={cn(common, 'text-fg-faint', className)} strokeWidth={1.5} {...aria} />
      )
    case 'running':
      return (
        <Spinner className={cn(common, 'text-accent', className)} label={label ?? LABELS.running} />
      )
    default:
      return <CircleDashed className={cn(common, 'text-fg-faint', className)} {...aria} />
  }
}
