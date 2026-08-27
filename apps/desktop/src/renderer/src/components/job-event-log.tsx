import type { ProgressEvent } from '@devmig/model'
import { useEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { formatClock } from '../lib/format'
import { phaseLabel } from '../lib/phases'

/** Monospace live log of job events. Debug events are hidden unless `verbose`. Auto-scrolls while at the bottom. */
export function JobEventLog({
  events,
  className,
  verbose = false,
  maxHeightClass = 'max-h-56',
  testId = 'job-event-log',
}: {
  events: ProgressEvent[]
  className?: string
  verbose?: boolean
  maxHeightClass?: string
  testId?: string
}): React.JSX.Element {
  const containerRef = useRef<HTMLOListElement>(null)
  const visible = verbose ? events : events.filter((e) => e.level !== 'debug')
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [visible.length])
  return (
    <ol
      ref={containerRef}
      data-testid={testId}
      aria-label="Activity log"
      aria-live="off"
      className={cn(
        'selectable flex flex-col gap-px overflow-y-auto rounded-panel bg-panel-2 p-3 font-mono text-[11.5px] leading-[18px] shadow-panel',
        maxHeightClass,
        className,
      )}
    >
      {visible.length === 0 ? (
        <li className="text-fg-faint">Waiting for the first event…</li>
      ) : null}
      {visible.map((e, i) => (
        <li
          key={`${e.at}-${i}`}
          className={cn(
            'flex gap-2',
            e.level === 'warn' && 'text-warn',
            e.level === 'error' && 'text-danger',
            e.level === 'debug' && 'text-fg-faint',
          )}
        >
          <span className="shrink-0 text-fg-faint tabular-nums">{formatClock(e.at)}</span>
          <span className="shrink-0 text-fg-faint">{phaseLabel(e.phase).toLowerCase()}</span>
          <span className="min-w-0 break-words">{e.message}</span>
        </li>
      ))}
    </ol>
  )
}
