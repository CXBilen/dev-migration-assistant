import type { ChecklistItem } from '../hooks/use-job'
import { cn } from '../lib/cn'
import { ProgressChecklist } from './progress-checklist'

/** Per-project checklists (from item-bearing progress events) plus an "Overall" group for job-level items. */
export function GroupedChecklist({
  items,
  projectNames,
  overallLabel = 'Backup file',
  className,
  testId = 'grouped-checklist',
}: {
  items: ChecklistItem[]
  projectNames: Record<string, string>
  overallLabel?: string
  className?: string
  testId?: string
}): React.JSX.Element {
  const groups = new Map<string, ChecklistItem[]>()
  for (const item of items) {
    const key = item.projectId ?? ''
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }
  const projectIds = Object.keys(projectNames)
  const ordered: { key: string; title: string; items: ChecklistItem[] }[] = []
  for (const pid of projectIds) {
    ordered.push({ key: pid, title: projectNames[pid] ?? pid, items: groups.get(pid) ?? [] })
  }
  for (const [key, list] of groups) {
    if (key !== '' && !projectNames[key]) ordered.push({ key, title: key, items: list })
  }
  const overall = groups.get('') ?? []
  return (
    <div className={cn('grid gap-4 sm:grid-cols-2', className)} data-testid={testId}>
      {ordered.map((g) => (
        <div
          key={g.key}
          className="rounded-panel bg-panel px-4 py-3 shadow-panel"
          data-testid={`${testId}-${g.key}`}
        >
          <ProgressChecklist
            title={g.title}
            items={
              g.items.length > 0
                ? g.items
                : [{ id: `${g.key}-waiting`, label: 'Waiting…', status: 'pending' as const }]
            }
          />
        </div>
      ))}
      {overall.length > 0 ? (
        <div
          className="rounded-panel bg-panel px-4 py-3 shadow-panel"
          data-testid={`${testId}-overall`}
        >
          <ProgressChecklist title={overallLabel} items={overall} />
        </div>
      ) : null}
    </div>
  )
}
