import { LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/cn'

export function Spinner({
  className,
  label,
}: {
  className?: string
  label?: string
}): React.JSX.Element {
  return (
    <LoaderCircle
      className={cn('size-4 animate-spin-slow text-fg-muted', className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  )
}
