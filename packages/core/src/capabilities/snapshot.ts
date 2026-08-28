/**
 * Capability snapshot (spec §5.3): what tools exist, where they came from, which Claude Code wrote
 * the transcripts. Recorded in every backup as `Manifest.capabilities` and probed again on the
 * destination by the bootstrap engine. Integrations/plugins are filled by recipes (Phase B).
 */
import {
  CAPABILITY_SNAPSHOT_VERSION,
  type CapabilitySnapshot,
  type MachineInfo,
  type ToolCapability,
} from '@devmig/model'
import type { Environment } from '../environment'
import { collectMachineInfo } from '../machine/collect-machine-info'
import { splitSearchPath, type SearchPathIo } from '../search-path'
import { displayVersion } from './versions'

export interface CollectCapabilitySnapshotInput {
  role: CapabilitySnapshot['role']
  /** Reuse an already-collected MachineInfo instead of probing again. */
  machine?: MachineInfo
  transcriptWriterVersions?: readonly string[]
  signal?: AbortSignal
  io?: SearchPathIo
  now?: () => Date
}

export function toolCapabilitiesOf(machine: MachineInfo): ToolCapability[] {
  return machine.tools.map((t) => ({
    id: t.id,
    label: t.label,
    installed: t.installed,
    version: t.installed ? displayVersion(t.version) : null,
    path: t.path ?? null,
    installMethod: t.installMethod ?? null,
  }))
}

export async function collectCapabilitySnapshot(
  env: Environment,
  input: CollectCapabilitySnapshotInput,
): Promise<CapabilitySnapshot> {
  const machine =
    input.machine ??
    (await collectMachineInfo(env.exec, {
      homeDir: env.homeDir,
      env: env.env,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.io ? { io: input.io } : {}),
    }))
  const tools = toolCapabilitiesOf(machine)
  const claude = tools.find((t) => t.id === 'claude')
  const writers = [...new Set(input.transcriptWriterVersions ?? [])].sort()
  return {
    schemaVersion: CAPABILITY_SNAPSHOT_VERSION,
    capturedAt: (input.now ?? (() => new Date()))().toISOString(),
    role: input.role,
    search: { paths: splitSearchPath(env.env.PATH) },
    tools,
    integrations: [],
    plugins: [],
    marketplaces: [],
    claude: {
      version: claude?.installed ? claude.version : null,
      installMethod: claude?.installed ? claude.installMethod : null,
      transcriptWriterVersions: writers,
    },
  }
}
