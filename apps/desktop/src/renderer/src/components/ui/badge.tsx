import { cva, type VariantProps } from 'class-variance-authority'
import type { Sensitivity } from '@devmig/model'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { cn } from '../../lib/cn'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-2xs font-medium leading-[14px] whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-info-soft text-info',
        ok: 'bg-ok-soft text-ok',
        warn: 'bg-warn-soft text-warn',
        danger: 'bg-danger-soft text-danger',
        accent: 'bg-accent-soft text-accent',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}

/** Sensitivity badge. `safe` renders nothing — the absence of a warning is the signal. */
export function SensitivityBadge({
  sensitivity,
  className,
}: {
  sensitivity: Sensitivity
  className?: string
}): React.JSX.Element | null {
  if (sensitivity === 'sensitive')
    return (
      <Badge tone="warn" className={className} title="May contain API keys or tokens">
        <ShieldAlert className="size-3" aria-hidden />
        Sensitive
      </Badge>
    )
  if (sensitivity === 'credential')
    return (
      <Badge tone="danger" className={className} title="Authentication credential — never migrated">
        <KeyRound className="size-3" aria-hidden />
        Credential
      </Badge>
    )
  return null
}
