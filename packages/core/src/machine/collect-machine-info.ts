/**
 * Collects the informational machine.json content (ADR-0003). Contains no secrets and no hostname.
 * Every tool probe is isolated: a missing binary or a hung process never fails the backup.
 */
import os from 'node:os'
import type { MachineInfo, ToolVersion } from '@devmig/model'
import type { Exec } from '@devmig/shared'

const TOOL_TIMEOUT_MS = 10_000

export interface CollectMachineInfoInput {
  homeDir: string
  env?: Record<string, string | undefined>
  /** Overrides for tests. */
  platform?: string
  arch?: string
  userName?: string
  signal?: AbortSignal
}

interface ToolProbe {
  id: string
  label: string
  file: string
  args: readonly string[]
  parse: (stdout: string) => string | null
}

const firstLine = (s: string): string | null => {
  const line = s.split(/\r?\n/).find((l) => l.trim() !== '')
  return line ? line.trim() : null
}

const TOOL_PROBES: ToolProbe[] = [
  { id: 'node', label: 'Node.js', file: 'node', args: ['--version'], parse: firstLine },
  { id: 'pnpm', label: 'pnpm', file: 'pnpm', args: ['--version'], parse: firstLine },
  { id: 'npm', label: 'npm', file: 'npm', args: ['--version'], parse: firstLine },
  { id: 'bun', label: 'Bun', file: 'bun', args: ['--version'], parse: firstLine },
  { id: 'git', label: 'Git', file: 'git', args: ['--version'], parse: firstLine },
  {
    id: 'claude',
    label: 'Claude Code',
    file: 'claude',
    args: ['--version'],
    // "2.1.247 (Claude Code)" -> "2.1.247"
    parse: (s) => firstLine(s)?.replace(/\s*\(.*\)\s*$/, '') ?? null,
  },
  { id: 'gh', label: 'GitHub CLI', file: 'gh', args: ['--version'], parse: firstLine },
  { id: 'brew', label: 'Homebrew', file: 'brew', args: ['--version'], parse: firstLine },
]

async function probeTool(
  exec: Exec,
  probe: ToolProbe,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolVersion> {
  const missing: ToolVersion = {
    id: probe.id,
    label: probe.label,
    version: null,
    path: null,
    installed: false,
  }
  try {
    const result = await exec(probe.file, probe.args, {
      timeoutMs: TOOL_TIMEOUT_MS,
      reject: false,
      env,
      signal,
    })
    if (result.failed) return missing
    const version = probe.parse(result.stdout)
    return { id: probe.id, label: probe.label, version, path: null, installed: true }
  } catch {
    return missing
  }
}

async function readOsVersion(
  exec: Exec,
  platform: string,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  if (platform !== 'darwin') return os.release() || null
  try {
    const result = await exec('sw_vers', ['-productVersion'], {
      timeoutMs: TOOL_TIMEOUT_MS,
      reject: false,
      env,
      signal,
    })
    if (result.failed) return null
    return firstLine(result.stdout)
  } catch {
    return null
  }
}

export async function collectMachineInfo(
  exec: Exec,
  input: CollectMachineInfoInput,
): Promise<MachineInfo> {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  let userName = input.userName
  if (userName === undefined) {
    try {
      userName = os.userInfo().username
    } catch {
      userName = input.env?.USER ?? input.env?.LOGNAME ?? 'unknown'
    }
  }
  const [osVersion, ...tools] = await Promise.all([
    readOsVersion(exec, platform, input.env, input.signal),
    ...TOOL_PROBES.map((probe) => probeTool(exec, probe, input.env, input.signal)),
  ])
  return {
    platform,
    arch,
    osVersion,
    machineLabel: null,
    homeDir: input.homeDir,
    userName,
    tools,
    capturedAt: new Date().toISOString(),
  }
}
