import { cn } from '../../lib/cn'

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  testId,
}: {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-border-strong px-6 py-10 text-center',
        className,
      )}
    >
      {icon ? <div className="text-fg-faint [&>svg]:size-7">{icon}</div> : null}
      <p className="text-[14px] font-medium">{title}</p>
      {description ? <p className="max-w-sm text-[13px] text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
