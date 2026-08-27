import type { SerializedError } from '@devmig/model'
import { Link } from 'react-router'
import { errorTitle, isCancelled } from '../../lib/errors'
import { ROUTES } from '../../lib/routes'
import { cn } from '../../lib/cn'
import { StatusIcon } from './status-icon'

/** Renders a SerializedError actionably: title, message, hint, code and a way to reach Diagnostics. */
export function ErrorPanel({
  error,
  className,
  actions,
  testId = 'error-panel',
}: {
  error: SerializedError
  className?: string
  actions?: React.ReactNode
  testId?: string
}): React.JSX.Element {
  const cancelled = isCancelled(error)
  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn(
        'flex gap-3 rounded-panel p-4',
        cancelled ? 'bg-warn-soft' : 'bg-danger-soft',
        className,
      )}
    >
      <StatusIcon status={cancelled ? 'warn' : 'error'} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-[13px] font-semibold">{errorTitle(error.code)}</p>
        <p className="selectable text-[13px] break-words">{error.message}</p>
        {error.hint ? (
          <p className="selectable text-[13px] text-fg-muted" data-testid={`${testId}-hint`}>
            {error.hint}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-faint">
          <code className="selectable font-mono">{error.code}</code>
          {!cancelled ? (
            <Link to={ROUTES.diagnostics} className="text-accent hover:underline">
              Open Diagnostics
            </Link>
          ) : null}
        </div>
        {actions ? <div className="mt-2 flex gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}
