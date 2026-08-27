/**
 * Detects a project's development runtime from files at its root: package manager (lockfiles /
 * `packageManager`), engines, Node version pins, frameworks by dependency name. Read-only, bounded reads.
 */
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { SummaryItem } from '@devmig/model'
import { throwIfAborted } from '@devmig/shared'
import {
  PackageJsonLoose,
  type FrameworkInfo,
  type NodeVersionPin,
  type PackageManagerId,
  type PackageManagerInfo,
  type ProjectRuntimeInfo,
} from './schema'
import { majorFromSpec, majorOf } from './versions'

const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024
const MAX_PIN_BYTES = 4096

/** Lockfile → package manager, in precedence order when several exist. */
export const LOCKFILES: readonly { file: string; id: PackageManagerId }[] = [
  { file: 'pnpm-lock.yaml', id: 'pnpm' },
  { file: 'bun.lockb', id: 'bun' },
  { file: 'bun.lock', id: 'bun' },
  { file: 'yarn.lock', id: 'yarn' },
  { file: 'package-lock.json', id: 'npm' },
  { file: 'npm-shrinkwrap.json', id: 'npm' },
]

export const FRAMEWORKS: readonly { dependency: string; label: string }[] = [
  { dependency: 'next', label: 'Next.js' },
  { dependency: 'nuxt', label: 'Nuxt' },
  { dependency: 'expo', label: 'Expo' },
  { dependency: 'electron', label: 'Electron' },
  { dependency: '@sveltejs/kit', label: 'SvelteKit' },
  { dependency: 'svelte', label: 'Svelte' },
  { dependency: 'vite', label: 'Vite' },
  { dependency: 'react', label: 'React' },
]

export interface DetectProjectRuntimeResult {
  runtime: ProjectRuntimeInfo
  warnings: string[]
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

async function readBounded(p: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle | undefined
  try {
    const stat = await fs.stat(p)
    if (!stat.isFile() || stat.size > maxBytes) return null
    handle = await fs.open(p, 'r')
    const buf = Buffer.alloc(stat.size)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** Parses `pnpm@11.5.3`, `yarn@4.5.0+sha512…` into an id + version. */
export function parsePackageManagerField(value: string | undefined): PackageManagerInfo | null {
  if (!value) return null
  const m = /^(pnpm|yarn|npm|bun)@([0-9][A-Za-z0-9.+-]*)$/.exec(value.trim())
  if (!m || m[1] === undefined || m[2] === undefined) return null
  const version = m[2].split('+')[0] ?? m[2]
  return { id: m[1] as PackageManagerId, version, source: 'packageManager', lockfile: null }
}

function parseNodePin(source: NodeVersionPin['source'], text: string): NodeVersionPin | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'))
  if (!line) return null
  const raw = line.replace(/^v/i, '').slice(0, 64)
  return { source, raw, major: /^\d/.test(raw) ? majorOf(raw) : null }
}

export async function detectProjectRuntime(
  root: string,
  signal?: AbortSignal,
): Promise<DetectProjectRuntimeResult> {
  const warnings: string[] = []
  throwIfAborted(signal)

  let pkg: PackageJsonLoose | null = null
  const packageJsonPath = path.join(root, 'package.json')
  const hasPackageJson = await exists(packageJsonPath)
  if (hasPackageJson) {
    const text = await readBounded(packageJsonPath, MAX_PACKAGE_JSON_BYTES)
    if (text === null) {
      warnings.push('package.json could not be read (too large or not a regular file).')
    } else {
      try {
        const parsed = PackageJsonLoose.safeParse(JSON.parse(text))
        if (parsed.success) pkg = parsed.data
        else warnings.push('package.json has an unexpected shape; runtime hints may be incomplete.')
      } catch {
        warnings.push('package.json is not valid JSON; runtime hints may be incomplete.')
      }
    }
  }

  const lockfiles: string[] = []
  for (const { file } of LOCKFILES) {
    throwIfAborted(signal)
    if (await exists(path.join(root, file))) lockfiles.push(file)
  }
  const declared = parsePackageManagerField(pkg?.packageManager)
  let packageManager: PackageManagerInfo | null = declared
  const firstLock = LOCKFILES.find((l) => lockfiles.includes(l.file))
  if (packageManager && firstLock) {
    packageManager = { ...packageManager, lockfile: firstLock.file }
  } else if (!packageManager && firstLock) {
    packageManager = {
      id: firstLock.id,
      version: null,
      source: 'lockfile',
      lockfile: firstLock.file,
    }
  }
  const managers = new Set(lockfiles.map((f) => LOCKFILES.find((l) => l.file === f)?.id))
  if (managers.size > 1) {
    warnings.push(
      `Several lockfiles found (${lockfiles.join(', ')}); ${packageManager?.id ?? 'none'} was assumed.`,
    )
  }

  let workspace: ProjectRuntimeInfo['workspace'] = null
  if (await exists(path.join(root, 'pnpm-workspace.yaml'))) workspace = 'pnpm-workspace.yaml'
  else if (pkg?.workspaces !== undefined) workspace = 'package.json'

  let nodePin: NodeVersionPin | null = null
  for (const source of ['.nvmrc', '.node-version'] as const) {
    const text = await readBounded(path.join(root, source), MAX_PIN_BYTES)
    if (text === null) continue
    nodePin = parseNodePin(source, text)
    if (nodePin) break
  }

  const frameworks: FrameworkInfo[] = []
  const deps: Record<string, string> = {
    ...(pkg?.devDependencies ?? {}),
    ...(pkg?.dependencies ?? {}),
  }
  for (const { dependency, label } of FRAMEWORKS) {
    const spec = deps[dependency]
    if (spec === undefined) continue
    frameworks.push({ id: dependency, label, spec, major: majorFromSpec(spec) })
  }

  const engines: Record<string, string> = {}
  for (const [key, value] of Object.entries(pkg?.engines ?? {})) {
    if (/^[A-Za-z0-9_-]{1,32}$/.test(key)) engines[key] = value
  }

  return {
    runtime: {
      hasPackageJson,
      packageName: pkg?.name ?? null,
      packageManager,
      lockfiles,
      workspace,
      engines,
      nodePin,
      frameworks,
    },
    warnings,
  }
}

export function frameworkDisplay(framework: FrameworkInfo): string {
  return framework.major !== null ? `${framework.label} ${framework.major}.x` : framework.label
}

/** True when the project carries at least one runtime hint worth backing up. */
export function hasRuntimeHints(runtime: ProjectRuntimeInfo): boolean {
  return (
    runtime.hasPackageJson ||
    runtime.packageManager !== null ||
    runtime.nodePin !== null ||
    runtime.lockfiles.length > 0
  )
}

export function summarizeProjectRuntime(runtime: ProjectRuntimeInfo): SummaryItem[] {
  const rows: SummaryItem[] = []
  if (runtime.workspace === 'pnpm-workspace.yaml') {
    rows.push({ label: 'pnpm workspace', status: 'ok', detail: 'pnpm-workspace.yaml' })
  } else if (runtime.workspace === 'package.json' && runtime.packageManager) {
    rows.push({
      label: `${runtime.packageManager.id} workspaces`,
      status: 'ok',
      detail: 'package.json workspaces',
    })
  }
  if (runtime.packageManager) {
    const pm = runtime.packageManager
    rows.push({
      label: pm.version ? `${pm.id} ${pm.version}` : pm.id,
      status: 'ok',
      detail:
        pm.source === 'packageManager' ? 'package.json packageManager' : (pm.lockfile ?? undefined),
    })
  } else {
    rows.push({ label: 'No package manager detected', status: 'info' })
  }
  if (runtime.nodePin) {
    rows.push({ label: `Node ${runtime.nodePin.raw} (${runtime.nodePin.source})`, status: 'ok' })
  }
  const nodeEngine = runtime.engines.node
  if (nodeEngine) rows.push({ label: `engines.node ${nodeEngine}`, status: 'info' })
  for (const framework of runtime.frameworks) {
    rows.push({ label: frameworkDisplay(framework), status: 'ok' })
  }
  return rows
}
