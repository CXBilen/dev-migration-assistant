import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'
import { Spinner } from './spinner'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-colors duration-150 ease-standard select-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-accent-fg shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)] hover:brightness-105 active:brightness-95',
        secondary:
          'bg-control text-fg shadow-[0_0_0_1px_var(--border-strong),0_1px_1px_rgba(0,0,0,0.04)] hover:bg-control-hover active:bg-control-hover',
        ghost: 'text-fg hover:bg-control-hover',
        danger: 'bg-danger text-white hover:brightness-105 active:brightness-95',
        link: 'text-accent underline-offset-2 hover:underline px-0 h-auto',
      },
      size: {
        sm: 'h-7 px-2.5 text-[12px]',
        md: 'h-8 px-3.5 text-[13px]',
        lg: 'h-10 px-5 text-[14px]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading = false, disabled, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner className="size-3.5" /> : null}
      {children}
    </button>
  )
})
