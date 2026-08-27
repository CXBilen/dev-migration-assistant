import { Check } from 'lucide-react'
import { Link, NavLink, useLocation } from 'react-router'
import { getApi } from '../api'
import { cn } from '../lib/cn'
import { ROUTES, wizardFor } from '../lib/routes'

/**
 * Window chrome: translucent sidebar (vibrancy shows through), a 52px draggable titlebar band
 * on both panes for the hiddenInset traffic lights, and the wizard step indicator.
 */
export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const location = useLocation()
  const wizard = wizardFor(location.pathname)
  const version = getApi().meta.appVersion
  const stepLabel =
    wizard.kind && wizard.index >= 0
      ? `${wizard.title} · Step ${wizard.index + 1} of ${wizard.steps.length}`
      : ''

  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside
        className="flex w-[220px] shrink-0 flex-col border-r border-border bg-sidebar backdrop-blur-2xl"
        aria-label="Navigation"
      >
        <div className="titlebar-drag h-[52px] shrink-0" aria-hidden />
        <div className="flex flex-1 flex-col overflow-y-auto px-3 pb-3">
          <Link
            to={ROUTES.home}
            className="mb-4 flex items-center gap-2 rounded-control px-2 py-1 text-[13px] font-semibold text-fg hover:bg-control-hover"
            data-testid="sidebar-home"
          >
            <span className="inline-flex size-5 items-center justify-center rounded-[6px] bg-accent text-accent-fg">
              <ArrowsGlyph />
            </span>
            Dev Migration Assistant
          </Link>

          {wizard.kind ? (
            <nav aria-label={`${wizard.title} steps`} className="flex flex-col gap-0.5">
              <p className="mb-1 px-2 text-[11px] font-semibold tracking-[0.06em] text-fg-faint uppercase">
                {wizard.title}
              </p>
              <ol className="flex flex-col gap-0.5">
                {wizard.steps.map((step, i) => {
                  const state =
                    i < wizard.index ? 'done' : i === wizard.index ? 'current' : 'upcoming'
                  return (
                    <li
                      key={step.path}
                      aria-current={state === 'current' ? 'step' : undefined}
                      data-testid={`sidebar-step-${i}`}
                      data-state={state}
                      className={cn(
                        'flex items-center gap-2.5 rounded-control px-2 py-1.5 text-[13px]',
                        state === 'current' && 'bg-accent-soft font-medium text-fg',
                        state === 'done' && 'text-fg-muted',
                        state === 'upcoming' && 'text-fg-faint',
                      )}
                    >
                      <span
                        className={cn(
                          'inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                          state === 'done' && 'bg-ok-soft text-ok',
                          state === 'current' && 'bg-accent text-accent-fg',
                          state === 'upcoming' && 'shadow-[0_0_0_1px_var(--border-strong)]',
                        )}
                        aria-hidden
                      >
                        {state === 'done' ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                      </span>
                      {step.label}
                    </li>
                  )
                })}
              </ol>
            </nav>
          ) : (
            <nav aria-label="Main" className="flex flex-col gap-0.5">
              <SidebarLink to={ROUTES.home} label="Home" testId="sidebar-nav-home" />
              <SidebarLink
                to={ROUTES.backupProjects}
                label="Create Backup"
                testId="sidebar-nav-backup"
              />
              <SidebarLink
                to={ROUTES.restore}
                label="Restore Backup"
                testId="sidebar-nav-restore"
              />
              <p className="mt-4 mb-1 px-2 text-[11px] font-semibold tracking-[0.06em] text-fg-faint uppercase">
                App
              </p>
              <SidebarLink to={ROUTES.settings} label="Settings" testId="sidebar-nav-settings" />
              <SidebarLink
                to={ROUTES.diagnostics}
                label="Diagnostics"
                testId="sidebar-nav-diagnostics"
              />
            </nav>
          )}

          <div className="mt-auto flex flex-col gap-1 px-2 pt-6 text-[11px] text-fg-faint">
            {wizard.kind ? (
              <Link to={ROUTES.diagnostics} className="hover:text-fg-muted">
                Diagnostics
              </Link>
            ) : null}
            <span>Version {version}</span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        <header className="titlebar-drag flex h-[52px] shrink-0 items-end px-8 pb-2.5">
          <span className="text-[12px] text-fg-faint" aria-live="polite">
            {stepLabel}
          </span>
        </header>
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  )
}

function SidebarLink({
  to,
  label,
  testId,
}: {
  to: string
  label: string
  testId: string
}): React.JSX.Element {
  return (
    <NavLink
      to={to}
      end
      data-testid={testId}
      className={({ isActive }) =>
        cn(
          'rounded-control px-2 py-1.5 text-[13px] text-fg-muted hover:bg-control-hover',
          isActive && 'bg-accent-soft font-medium text-fg',
        )
      }
    >
      {label}
    </NavLink>
  )
}

function ArrowsGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2 4h6.5M6.5 2l2 2-2 2M10 8H3.5M5.5 6l-2 2 2 2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
