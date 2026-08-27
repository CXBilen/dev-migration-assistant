import { cn } from '../../lib/cn'

/** macOS-style grouped panel: white surface, hairline ring, generous padding. */
export function Panel({
  className,
  children,
  title,
  description,
  actions,
  testId,
  padded = true,
}: {
  className?: string
  children: React.ReactNode
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  testId?: string
  padded?: boolean
}): React.JSX.Element {
  return (
    <section data-testid={testId} className={cn('rounded-panel bg-panel shadow-panel', className)}>
      {title ? (
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold">{title}</h3>
            {description ? <p className="mt-0.5 text-[12px] text-fg-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(padded && 'px-4 py-3')}>{children}</div>
    </section>
  )
}

/** Small uppercase section label used between panels. */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <h2
      className={cn(
        'text-[11px] font-semibold tracking-[0.06em] text-fg-faint uppercase',
        className,
      )}
    >
      {children}
    </h2>
  )
}

/** A row inside a panel: hairline separators, consistent height. */
export function Row({
  className,
  children,
  testId,
}: {
  className?: string
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-center gap-3 border-b border-border py-2 last:border-b-0',
        className,
      )}
    >
      {children}
    </div>
  )
}
