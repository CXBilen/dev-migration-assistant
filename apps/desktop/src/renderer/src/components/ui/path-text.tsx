import { abbreviatePath } from '../../lib/paths'
import { cn } from '../../lib/cn'

/** Monospace path with the home directory abbreviated to ~. Full path stays available via title. */
export function PathText({
  path,
  homeDir,
  className,
  abbreviate = true,
}: {
  path: string
  homeDir?: string | null
  className?: string
  abbreviate?: boolean
}): React.JSX.Element {
  const shown = abbreviate ? abbreviatePath(path, homeDir) : path
  return (
    <span
      className={cn('selectable font-mono text-[12px] text-fg-muted wrap-anywhere', className)}
      title={path}
    >
      {shown}
    </span>
  )
}
