/** Context builders shared by this package's tests (never exported from index.ts). */
import path from 'node:path'
import type {
  BackupContext,
  RestoreContext,
  RestorePlanningContext,
  ScanContext,
  VerifyContext,
} from '@devmig/core'
import { createPathMapper } from '@devmig/core'
import type { CollisionPolicy, PathMapping, ProjectDescriptor } from '@devmig/model'
import { ScopedFs, noopLogger, realExec, stableId, type Exec } from '@devmig/shared'

export interface TestHome {
  homeDir: string
  claudeConfigDir: string
  claudeJsonPath: string
  env: Record<string, string | undefined>
}

export function describeProject(
  realPath: string,
  git?: ProjectDescriptor['git'],
): ProjectDescriptor {
  return {
    id: stableId(realPath),
    name: path.basename(realPath),
    originalPath: realPath,
    canonicalPath: realPath,
    realPath,
    ...(git ? { git } : {}),
    detectedProviders: [],
  }
}

function base(home: TestHome, exec: Exec, signal: AbortSignal) {
  return {
    homeDir: home.homeDir,
    claudeConfigDir: home.claudeConfigDir,
    claudeJsonPath: home.claudeJsonPath,
    env: home.env,
    exec,
    logger: noopLogger,
    signal,
    progress: () => {},
  }
}

export function scanContext(
  home: TestHome,
  allProjects: ProjectDescriptor[],
  opts: { exec?: Exec; signal?: AbortSignal } = {},
): ScanContext {
  return {
    ...base(home, opts.exec ?? realExec, opts.signal ?? new AbortController().signal),
    allProjects,
  }
}

export function backupContext(
  home: TestHome,
  stagingRoot: string,
  unit: { projectId?: string },
  opts: { exec?: Exec; signal?: AbortSignal } = {},
): BackupContext & { relDir: string; providerDir: string } {
  const relDir = unit.projectId ? `projects/${unit.projectId}/claude-code` : 'global/claude-code'
  const providerDir = path.join(stagingRoot, ...relDir.split('/'))
  return {
    ...base(home, opts.exec ?? realExec, opts.signal ?? new AbortController().signal),
    stagingDir: providerDir,
    fs: new ScopedFs([providerDir]),
    payloadPathFor: (rel) => `${relDir}/${rel.split(path.sep).join('/')}`,
    tempDir: path.join(stagingRoot, 'tmp'),
    relDir,
    providerDir,
  }
}

export function planningContext(
  home: TestHome,
  payloadRoot: string,
  mappings: PathMapping[],
  opts: {
    exec?: Exec
    signal?: AbortSignal
    defaultCollisionPolicy?: CollisionPolicy
    restoreHints?: Record<string, unknown>
  } = {},
): RestorePlanningContext {
  const mapper = createPathMapper(mappings, { homeDir: home.homeDir })
  return {
    ...base(home, opts.exec ?? realExec, opts.signal ?? new AbortController().signal),
    payloadRoot,
    mappings,
    mapPath: (p) => mapper.mapPath(p),
    defaultCollisionPolicy: opts.defaultCollisionPolicy ?? 'skip',
    restoreHints: opts.restoreHints ?? {},
  }
}

export function restoreContext(
  home: TestHome,
  payloadRoot: string,
  mappings: PathMapping[],
  roots: string[],
  opts: {
    exec?: Exec
    signal?: AbortSignal
    collisionDecisions?: Record<string, CollisionPolicy>
    tempDir?: string
  } = {},
): RestoreContext {
  const mapper = createPathMapper(mappings, { homeDir: home.homeDir })
  return {
    ...base(home, opts.exec ?? realExec, opts.signal ?? new AbortController().signal),
    payloadRoot,
    mappings,
    mapPath: (p) => mapper.mapPath(p),
    fs: new ScopedFs(roots),
    collisionDecisions: opts.collisionDecisions ?? {},
    tempDir: opts.tempDir ?? path.join(payloadRoot, '..', 'restore-tmp'),
  }
}

export function verifyContext(
  home: TestHome,
  payloadRoot: string,
  mappings: PathMapping[],
  opts: { exec?: Exec } = {},
): VerifyContext {
  const mapper = createPathMapper(mappings, { homeDir: home.homeDir })
  return {
    ...base(home, opts.exec ?? realExec, new AbortController().signal),
    payloadRoot,
    mapPath: (p) => mapper.mapPath(p),
  }
}
