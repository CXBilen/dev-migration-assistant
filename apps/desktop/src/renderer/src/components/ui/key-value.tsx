import { cn } from '../../lib/cn'

export interface KeyValueItem {
  key: string
  value: React.ReactNode
  testId?: string
}

/** Definition list with aligned keys — the information-dense layout used across Diagnostics and reports. */
export function KeyValueList({
  items,
  className,
}: {
  items: KeyValueItem[]
  className?: string
}): React.JSX.Element {
  return (
    <dl
      className={cn(
        'grid grid-cols-[minmax(140px,max-content)_1fr] gap-x-6 gap-y-1.5 text-[13px]',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt className="text-fg-muted">{item.key}</dt>
          <dd className="selectable min-w-0 break-words" data-testid={item.testId}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
