/**
 * Source-vs-destination comparison of development tools. Produces the restore report rows, the
 * attention items and structured remediations. Pure: no I/O.
 */
import type { AttentionItem, MachineInfo, ResultItem, ToolVersion } from '@devmig/model'
import { REMEDIATIONS, formatRemediation, type Remediation } from './remediation'
import type { ProjectRuntimeInfo } from './schema'
import { displayVersion, majorOf, toolLabel } from './versions'

export const RUNTIME_PROVIDER_ID = 'runtime'

export type GhAuthStatus = 'ok' | 'unauthenticated' | 'unavailable' | 'not-installed'

export interface ComparisonOutput {
  items: ResultItem[]
  attention: AttentionItem[]
  remediations: Remediation[]
}

function tool(machine: MachineInfo, id: string): ToolVersion | undefined {
  return machine.tools.find((t) => t.id === id)
}

function version(t: ToolVersion | undefined): string | null {
  return t?.installed ? (displayVersion(t.version) ?? '?') : null
}

function attentionFor(
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
  const gitDest = tool(destination, 'git')
  if (gitDest?.installed) {
    items.push({ label: 'Git installed', status: 'ok', detail: version(gitDest) ?? undefined })
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
  const nodeSrc = tool(source, 'node')
  const nodeDest = tool(destination, 'node')
  const srcMajor = nodeSrc?.installed ? majorOf(nodeSrc.version) : null
  const destMajor = nodeDest?.installed ? majorOf(nodeDest.version) : null
  if (nodeDest?.installed && (srcMajor === null || srcMajor === destMajor)) {
    items.push({
      label:
        srcMajor !== null
          ? `Node compatible (${srcMajor} → ${destMajor ?? '?'})`
          : `Node installed`,
      status: 'ok',
      detail: version(nodeDest) ?? undefined,
    })
  } else if (nodeDest?.installed) {
    const r = REMEDIATIONS.switchNode(srcMajor as number)
    items.push({
      label: `Node major differs (${srcMajor} → ${destMajor ?? '?'})`,
      status: 'warn',
      detail: `Source ${version(nodeSrc) ?? '?'}, this Mac ${version(nodeDest) ?? '?'}`,
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
      detail: `Source used ${version(nodeSrc) ?? '?'}`,
    })
    push(attentionFor('node-missing', 'warn', 'Node.js is not installed', 'install', r), r)
  }

  // Package managers the source machine had
  for (const id of ['pnpm', 'npm', 'bun'] as const) {
    const src = tool(source, id)
    if (!src?.installed) continue
    const dest = tool(destination, id)
    const label = toolLabel(id, src.label)
    if (dest?.installed) {
      const same = version(src) === version(dest)
      items.push({
        label: `${label} installed`,
        status: 'ok',
        detail: same
          ? (version(dest) ?? undefined)
          : `${version(src) ?? '?'} → ${version(dest) ?? '?'}`,
      })
    } else {
      const r = REMEDIATIONS.installPackageManager(id, version(src))
      items.push({
        label: `${label} not installed`,
        status: 'warn',
        detail: `Source used ${version(src) ?? '?'}`,
      })
      push(attentionFor(`pm-missing-${id}`, 'warn', `${label} is not installed`, 'install', r), r)
    }
  }

  // Claude Code
  const claudeSrc = tool(source, 'claude')
  const claudeDest = tool(destination, 'claude')
  if (claudeDest?.installed) {
    const same = version(claudeSrc) === version(claudeDest)
    items.push({
      label: 'Claude Code installed',
      status: 'ok',
      detail:
        claudeSrc?.installed && !same
          ? `${version(claudeSrc) ?? '?'} → ${version(claudeDest) ?? '?'}`
          : (version(claudeDest) ?? undefined),
    })
  } else {
    const r = REMEDIATIONS.installClaudeCode()
    items.push({
      label: 'Claude Code not installed',
      status: 'warn',
      detail: claudeSrc?.installed ? `Source used ${version(claudeSrc) ?? '?'}` : undefined,
    })
    push(
      attentionFor('claude-code-missing', 'warn', 'Claude Code is not installed', 'install', r),
      r,
    )
  }

  // GitHub CLI
  const ghDest = tool(destination, 'gh')
  if (!ghDest?.installed || ghAuth === 'not-installed') {
    const r = REMEDIATIONS.installGh()
    items.push({ label: 'GitHub CLI not installed', status: 'info' })
    push(attentionFor('gh-missing', 'info', 'GitHub CLI is not installed', 'install', r), r)
  } else if (ghAuth === 'ok') {
    items.push({
      label: 'GitHub CLI authenticated',
      status: 'ok',
      detail: version(ghDest) ?? undefined,
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
  const brewDest = tool(destination, 'brew')
  if (tool(source, 'brew')?.installed && !brewDest?.installed) {
    items.push({ label: 'Homebrew not installed', status: 'info', detail: 'https://brew.sh' })
  }

  return { items, attention, remediations }
}

/** Compares a project's declared runtime with the destination machine. */
export function compareProjectRuntime(
  projectId: string,
  runtime: ProjectRuntimeInfo,
  destination: MachineInfo,
): ComparisonOutput {
  const items: ResultItem[] = []
  const attention: AttentionItem[] = []
  const remediations: Remediation[] = []

  const pm = runtime.packageManager
  if (pm) {
    const dest = tool(destination, pm.id)
    const label = toolLabel(pm.id, pm.id)
    if (dest?.installed) {
      const destVersion = version(dest)
      const mismatch = pm.version !== null && destVersion !== null && pm.version !== destVersion
      items.push({
        label: `${label} installed`,
        status: mismatch ? 'info' : 'ok',
        detail: mismatch
          ? `project pins ${pm.version}, this Mac has ${destVersion}`
          : (destVersion ?? undefined),
      })
    } else {
      const r = REMEDIATIONS.installPackageManager(pm.id, pm.version)
      items.push({
        label: `${label} not installed`,
        status: 'warn',
        detail: `Project uses ${pm.id}${pm.version ? ` ${pm.version}` : ''}`,
      })
      const a = attentionFor(
        `${projectId}:pm-missing-${pm.id}`,
        'warn',
        `${label} is not installed`,
        'install',
        r,
      )
      attention.push(a)
      remediations.push(r)
    }
  }

  const nodeDest = tool(destination, 'node')
  const destMajor = nodeDest?.installed ? majorOf(nodeDest.version) : null
  const pinMajor = runtime.nodePin?.major ?? null
  const engineMajor = majorOf(runtime.engines.node)
  const wanted = pinMajor ?? engineMajor
  if (wanted !== null) {
    const via = runtime.nodePin ? runtime.nodePin.source : 'engines.node'
    if (destMajor === null) {
      const r = REMEDIATIONS.installNode(wanted)
      items.push({
        label: `Node ${wanted} required (${via})`,
        status: 'warn',
        detail: 'Node is not installed',
      })
      attention.push(
        attentionFor(
          `${projectId}:node-missing`,
          'warn',
          `Node.js ${wanted} is required by the project`,
          'install',
          r,
        ),
      )
      remediations.push(r)
    } else if (pinMajor !== null ? destMajor !== pinMajor : destMajor < wanted) {
      const r = REMEDIATIONS.switchNode(wanted)
      items.push({
        label: `Node major differs (${wanted} → ${destMajor})`,
        status: 'warn',
        detail: `${via} asks for ${runtime.nodePin?.raw ?? runtime.engines.node ?? wanted}`,
      })
      attention.push(
        attentionFor(
          `${projectId}:node-major`,
          'warn',
          `Project expects Node.js ${wanted}`,
          'manual',
          r,
        ),
      )
      remediations.push(r)
    } else {
      items.push({ label: `Node compatible (${wanted} → ${destMajor})`, status: 'ok', detail: via })
    }
  }

  for (const framework of runtime.frameworks) {
    items.push({
      label: framework.major !== null ? `${framework.label} ${framework.major}.x` : framework.label,
      status: 'info',
      detail: 'reinstall dependencies after restore',
    })
  }
  return { items, attention, remediations }
}
