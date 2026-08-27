import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { forwardRef } from 'react'
import { cn } from '../../lib/cn'

export type CheckboxProps = React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { className, checked, ...props },
  ref,
) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      checked={checked}
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-control shadow-[0_0_0_1px_var(--border-strong)] transition-colors',
        'data-[state=checked]:bg-accent data-[state=checked]:text-accent-fg data-[state=checked]:shadow-none',
        'data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-accent-fg data-[state=indeterminate]:shadow-none',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {checked === 'indeterminate' ? (
          <Minus className="size-3" strokeWidth={3} aria-hidden />
        ) : (
          <Check className="size-3" strokeWidth={3} aria-hidden />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
})
