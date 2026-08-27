import * as SwitchPrimitive from '@radix-ui/react-switch'
import { forwardRef } from 'react'
import { cn } from '../../lib/cn'

export type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { className, ...props },
  ref,
) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'relative inline-flex h-[18px] w-[30px] shrink-0 cursor-pointer items-center rounded-full bg-border-strong transition-colors',
        'data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[14px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform data-[state=checked]:translate-x-[14px]" />
    </SwitchPrimitive.Root>
  )
})
