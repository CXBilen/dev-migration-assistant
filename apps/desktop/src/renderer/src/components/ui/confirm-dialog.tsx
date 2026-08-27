import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cn } from '../../lib/cn'
import { Button } from './button'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** Destructive confirmations are rendered with the danger style and never as the default button. */
  destructive?: boolean
  onConfirm: () => void
  pending?: boolean
  testId?: string
}

/** Modal confirmation built on Radix Dialog: focus-trapped, Escape closes, labelled for screen readers. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  pending = false,
  testId,
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          data-testid={testId}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-panel bg-panel p-5 shadow-[0_0_0_1px_var(--border),0_20px_50px_rgba(0,0,0,0.25)] outline-none',
          )}
        >
          <DialogPrimitive.Title className="text-[15px] font-semibold">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description asChild>
            <div className="mt-2 text-[13px] leading-relaxed text-fg-muted">{description}</div>
          </DialogPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button
                variant="secondary"
                autoFocus={destructive}
                data-testid={testId ? `${testId}-cancel` : undefined}
              >
                {cancelLabel}
              </Button>
            </DialogPrimitive.Close>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              onClick={onConfirm}
              loading={pending}
              autoFocus={!destructive}
              data-testid={testId ? `${testId}-confirm` : undefined}
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** Generic dialog shell for small forms (e.g. password prompts). */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  testId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          data-testid={testId}
          aria-describedby={description ? undefined : undefined}
          className="fixed top-1/2 left-1/2 z-50 w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-panel bg-panel p-5 shadow-[0_0_0_1px_var(--border),0_20px_50px_rgba(0,0,0,0.25)] outline-none"
        >
          <DialogPrimitive.Title className="text-[15px] font-semibold">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-1 text-[13px] text-fg-muted">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
          <div className="mt-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
