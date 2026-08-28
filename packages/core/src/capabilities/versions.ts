/** Small, dependency-free version helpers (tool output is free text; only the numeric core is used). */

const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/

/** Extracts `major.minor[.patch]` from strings like "v22.22.3", "git version 2.50.1", "gh version 2.63.0 (2025-01-01)". */
export function displayVersion(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = VERSION_RE.exec(raw)
  if (!m) return raw.trim().slice(0, 32) || null
  return m[3] !== undefined ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`
}

/** Major version number, or null when the string carries none. */
export function majorOf(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = /(\d+)/.exec(raw)
  if (!m || m[1] === undefined) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

/** Major from a dependency spec such as "^15.1.0", "~19.0.0", ">=22.12.0", "15", "15.x". */
export function majorFromSpec(spec: string | null | undefined): number | null {
  if (!spec) return null
  const trimmed = spec.trim()
  if (
    /^(latest|next|canary|\*|x|workspace:.*|file:.*|link:.*|npm:.*|git.*|https?:.*)$/i.test(trimmed)
  )
    return null
  return majorOf(trimmed)
}

/** Display label per tool id used by collectMachineInfo. */
export const TOOL_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  node: 'Node',
  pnpm: 'pnpm',
  npm: 'npm',
  bun: 'Bun',
  git: 'Git',
  claude: 'Claude Code',
  gh: 'GitHub CLI',
  brew: 'Homebrew',
}

export function toolLabel(id: string, fallback: string): string {
  return TOOL_DISPLAY_LABELS[id] ?? fallback
}
