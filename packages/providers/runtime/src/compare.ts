/** Project-level comparison; the machine-level `compareMachines` lives in @devmig/core. */
import {
  REMEDIATIONS,
  attentionFor,
  majorOf,
  toolLabel,
  toolOf,
  toolVersionOf,
  type ComparisonOutput,
  type Remediation,
} from '@devmig/core'
import type { AttentionItem, MachineInfo, ResultItem } from '@devmig/model'
import type { ProjectRuntimeInfo } from './schema'

export { RUNTIME_PROVIDER_ID, compareMachines } from '@devmig/core'
export type { ComparisonOutput, GhAuthStatus } from '@devmig/core'

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
    const dest = toolOf(destination, pm.id)
    const label = toolLabel(pm.id, pm.id)
    if (dest?.installed) {
      const destVersion = toolVersionOf(dest)
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

  const nodeDest = toolOf(destination, 'node')
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
