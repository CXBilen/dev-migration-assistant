/**
 * Source-vs-destination comparison of development tools. Produces restore report rows, attention
 * items and structured remediations. Pure: no I/O. `compareProjectRuntime` stays in the runtime
 * provider because it needs that provider's project payload schema.
 */
import type {
  AttentionItem,
  MachineInfo,
  Remediation,
  ResultItem,
  ToolVersion,
} from '@devmig/model'
import { REMEDIATIONS, formatRemediation } from './remediation'
import { displayVersion, majorOf, toolLabel } from './versions'

export const RUNTIME_PROVIDER_ID = 'runtime'

export type GhAuthStatus = 'ok' | 'unauthenticated' | 'unavailable' | 'not-installed'

export interface ComparisonOutput {
  items: ResultItem[]
  attention: AttentionItem[]
  remediations: Remediation[]
}

export function toolOf(machine: MachineInfo, id: string): ToolVersion | undefined {
  return machine.tools.find((t) => t.id === id)
}

export function toolVersionOf(t: ToolVersion | undefined): string | null {
  return t?.installed ? (displayVersion(t.version) ?? '?') : null
}

export function attentionFor(
  id: string,
  level: AttentionItem['level'],
  title: string,
  action: AttentionItem['action'],
  remediation: Remediation,
): AttentionItem {
  return {
    id: `${RUNTIME_PROVIDER_ID}:${id}`,
    providerId: RUNTIME_PROVIDER_ID,
    level,
    title,
    detail: formatRemediation(remediation),
    action,
  }
}

function osLabel(machine: MachineInfo): string {
  const os = machine.platform === 'darwin' ? 'macOS' : machine.platform
  return `${os}${machine.osVersion ? ` ${machine.osVersion}` : ''} ${machine.arch}`
}

/** Compares the source machine (from the backup) with the destination (probed now). */
export function compareMachines(
  source: MachineInfo,
  destination: MachineInfo,
  ghAuth: GhAuthStatus,
): ComparisonOutput {
  const items: ResultItem[] = []
  const attention: AttentionItem[] = []
  const remediations: Remediation[] = []
  const push = (a: AttentionItem, r: Remediation): void => {
    attention.push(a)
    remediations.push(r)
  }

  // Platform / architecture
  if (source.arch !== destination.arch) {
    const pm =
      source.tools.find((t) => t.installed && (t.id === 'pnpm' || t.id === 'bun'))?.id ?? null
    const r = REMEDIATIONS.reinstallNativeDependencies(pm)
    items.push({
      label: `CPU architecture differs (${source.arch} → ${destination.arch})`,
      status: 'warn',
      detail: 'Native dependencies must be reinstalled',
    })
    push(attentionFor('arch', 'warn', 'Reinstall native dependencies', 'manual', r), r)
  } else {
    items.push({ label: `${osLabel(source)} → ${osLabel(destination)}`, status: 'info' })
  }

  // Git
  const gitDest = toolOf(destination, 'git')
  if (gitDest?.installed) {
    items.push({
      label: 'Git installed',
      status: 'ok',
      detail: toolVersionOf(gitDest) ?? undefined,
    })
  } else {
    const r = REMEDIATIONS.installGit()
    items.push({
      label: 'Git not installed',
      status: 'error',
      detail: 'Repositories cannot be restored without Git',
    })
    push(attentionFor('git-missing', 'warn', 'Git is not installed', 'install', r), r)
  }

  // Node
  const nodeSrc = toolOf(source, 'node')
  const nodeDest = toolOf(destination, 'node')
  const srcMajor = nodeSrc?.installed ? majorOf(nodeSrc.version) : null
  const destMajor = nodeDest?.installed ? majorOf(nodeDest.version) : null
  if (nodeDest?.installed && (srcMajor === null || srcMajor === destMajor)) {
    items.push({
      label:
        srcMajor !== null
          ? `Node compatible (${srcMajor} → ${destMajor ?? '?'})`
          : `Node installed`,
      status: 'ok',
      detail: toolVersionOf(nodeDest) ?? undefined,
    })
  } else if (nodeDest?.installed) {
    const r = REMEDIATIONS.switchNode(srcMajor as number)
    items.push({
      label: `Node major differs (${srcMajor} → ${destMajor ?? '?'})`,
      status: 'warn',
      detail: `Source ${toolVersionOf(nodeSrc) ?? '?'}, this Mac ${toolVersionOf(nodeDest) ?? '?'}`,
    })
    push(
      attentionFor(
        'node-major',
        'warn',
        `Node.js ${srcMajor} was used on the source machine`,
        'manual',
        r,
      ),
      r,
    )
  } else if (nodeSrc?.installed) {
    const r = REMEDIATIONS.installNode(srcMajor)
    items.push({
      label: 'Node not installed',
      status: 'warn',
      detail: `Source used ${toolVersionOf(nodeSrc) ?? '?'}`,
    })
    push(attentionFor('node-missing', 'warn', 'Node.js is not installed', 'install', r), r)
  }

  // Package managers the source machine had
  for (const id of ['pnpm', 'npm', 'bun'] as const) {
    const src = toolOf(source, id)
    if (!src?.installed) continue
    const dest = toolOf(destination, id)
    const label = toolLabel(id, src.label)
    if (dest?.installed) {
      const same = toolVersionOf(src) === toolVersionOf(dest)
      items.push({
        label: `${label} installed`,
        status: 'ok',
        detail: same
          ? (toolVersionOf(dest) ?? undefined)
          : `${toolVersionOf(src) ?? '?'} → ${toolVersionOf(dest) ?? '?'}`,
      })
    } else {
      const r = REMEDIATIONS.installPackageManager(id, toolVersionOf(src))
      items.push({
        label: `${label} not installed`,
        status: 'warn',
        detail: `Source used ${toolVersionOf(src) ?? '?'}`,
      })
      push(attentionFor(`pm-missing-${id}`, 'warn', `${label} is not installed`, 'install', r), r)
    }
  }

  // Claude Code
  const claudeSrc = toolOf(source, 'claude')
  const claudeDest = toolOf(destination, 'claude')
  if (claudeDest?.installed) {
    const same = toolVersionOf(claudeSrc) === toolVersionOf(claudeDest)
    items.push({
      label: 'Claude Code installed',
      status: 'ok',
      detail:
        claudeSrc?.installed && !same
          ? `${toolVersionOf(claudeSrc) ?? '?'} → ${toolVersionOf(claudeDest) ?? '?'}`
          : (toolVersionOf(claudeDest) ?? undefined),
    })
  } else {
    const r = REMEDIATIONS.installClaudeCode()
    items.push({
      label: 'Claude Code not installed',
      status: 'warn',
      detail: claudeSrc?.installed ? `Source used ${toolVersionOf(claudeSrc) ?? '?'}` : undefined,
    })
    push(
      attentionFor('claude-code-missing', 'warn', 'Claude Code is not installed', 'install', r),
      r,
    )
  }

  // GitHub CLI
  const ghDest = toolOf(destination, 'gh')
  if (!ghDest?.installed || ghAuth === 'not-installed') {
    const r = REMEDIATIONS.installGh()
    items.push({ label: 'GitHub CLI not installed', status: 'info' })
    push(attentionFor('gh-missing', 'info', 'GitHub CLI is not installed', 'install', r), r)
  } else if (ghAuth === 'ok') {
    items.push({
      label: 'GitHub CLI authenticated',
      status: 'ok',
      detail: toolVersionOf(ghDest) ?? undefined,
    })
  } else {
    const r = REMEDIATIONS.ghLogin()
    items.push({
      label: 'GitHub CLI authentication required',
      status: 'warn',
      detail: ghAuth === 'unavailable' ? 'Could not verify the login state' : 'Not logged in',
    })
    push(attentionFor('gh-auth', 'warn', 'GitHub CLI authentication required', 'reauth', r), r)
  }

  // Homebrew (informational)
  const brewDest = toolOf(destination, 'brew')
  if (toolOf(source, 'brew')?.installed && !brewDest?.installed) {
    items.push({ label: 'Homebrew not installed', status: 'info', detail: 'https://brew.sh' })
  }

  return { items, attention, remediations }
}
