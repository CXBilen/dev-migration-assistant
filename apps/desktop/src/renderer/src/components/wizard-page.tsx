import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router'
import { cn } from '../lib/cn'
import { Button } from './ui/button'

export interface WizardPageProps {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  /** Left side of the footer (status text, totals). */
  footerStart?: React.ReactNode
  /** Right side of the footer (primary actions). */
  footerEnd?: React.ReactNode
  /** Back button target; omit to hide. */
  backTo?: string | (() => void)
  backLabel?: string
  backDisabled?: boolean
  headerEnd?: React.ReactNode
  testId?: string
  contentClassName?: string
  /** Use a narrower measure for form-like screens. */
  narrow?: boolean
}

/** Standard wizard step layout: header, scrollable content, sticky footer with Back / primary action. */
export function WizardPage({
  title,
  description,
  children,
  footerStart,
  footerEnd,
  backTo,
  backLabel = 'Back',
  backDisabled = false,
  headerEnd,
  testId,
  contentClassName,
  narrow = false,
}: WizardPageProps): React.JSX.Element {
  const navigate = useNavigate()
  const onBack = (): void => {
    if (typeof backTo === 'function') backTo()
    else if (backTo) void navigate(backTo)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <div className={cn('shrink-0 px-8 pb-4', narrow && 'max-w-3xl')}>
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.01em]">{title}</h1>
            {description ? (
              <p className="mt-1 max-w-2xl text-[13px] text-fg-muted">{description}</p>
            ) : null}
          </div>
          {headerEnd ? <div className="shrink-0 pt-1">{headerEnd}</div> : null}
        </div>
      </div>
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-8 pb-6', contentClassName)}>
        <div className={cn('flex flex-col gap-4', narrow && 'max-w-3xl')}>{children}</div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-panel-2 px-8 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {backTo ? (
            <Button
              variant="ghost"
              onClick={onBack}
              disabled={backDisabled}
              data-testid="wizard-back"
            >
              <ArrowLeft className="size-4" aria-hidden />
              {backLabel}
            </Button>
          ) : null}
          <div className="min-w-0 text-[12px] text-fg-muted">{footerStart}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">{footerEnd}</div>
      </footer>
    </div>
  )
}
