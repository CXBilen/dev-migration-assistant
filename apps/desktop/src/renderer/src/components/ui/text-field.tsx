import { forwardRef, useId, type InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string
  /** Visually hide the label (still announced). */
  hideLabel?: boolean
  hint?: React.ReactNode
  error?: React.ReactNode
  trailing?: React.ReactNode
  id?: string
  inputClassName?: string
}

export const inputClass =
  'h-8 w-full min-w-0 rounded-control bg-control px-2.5 text-[13px] text-fg shadow-[0_0_0_1px_var(--border-strong)] placeholder:text-fg-faint outline-none focus-visible:shadow-[0_0_0_1px_var(--focus)] disabled:opacity-50 aria-invalid:shadow-[0_0_0_1px_var(--danger)]'

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    label,
    hideLabel = false,
    hint,
    error,
    trailing,
    id: idProp,
    className,
    inputClassName,
    ...props
  },
  ref,
) {
  const autoId = useId()
  const id = idProp ?? autoId
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label
        htmlFor={id}
        className={cn('text-[12px] font-medium text-fg-muted', hideLabel && 'sr-only')}
      >
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          id={id}
          className={cn(inputClass, inputClassName)}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
          }
          {...props}
        />
        {trailing}
      </div>
      {error ? (
        <p id={errorId} className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[12px] text-fg-faint">
          {hint}
        </p>
      ) : null}
    </div>
  )
})
