import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { forwardRef } from 'react'
import { cn } from '../../lib/cn'

export const RadioGroup = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(function RadioGroup({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Root
      ref={ref}
      className={cn('flex flex-col gap-1.5', className)}
      {...props}
    />
  )
})

export interface RadioItemProps extends React.ComponentPropsWithoutRef<
  typeof RadioGroupPrimitive.Item
> {
  label: React.ReactNode
  description?: React.ReactNode
}

export const RadioItem = forwardRef<HTMLButtonElement, RadioItemProps>(function RadioItem(
  { className, label, description, id, ...props },
  ref,
) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-2 text-[13px]',
        props.disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <RadioGroupPrimitive.Item
        ref={ref}
        id={id}
        className="mt-[3px] inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-control shadow-[0_0_0_1px_var(--border-strong)] data-[state=checked]:bg-accent data-[state=checked]:shadow-none"
        {...props}
      >
        <RadioGroupPrimitive.Indicator className="block size-1.5 rounded-full bg-accent-fg" />
      </RadioGroupPrimitive.Item>
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        {description ? <span className="text-fg-muted">{description}</span> : null}
      </span>
    </label>
  )
})
