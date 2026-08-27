/** Test-only context builders; everything points at caller-provided temp directories. */
import path from 'node:path'
import {
  createPathMapper,
  type BackupContext,
  type BaseContext,
  type RestoreContext,
  type RestorePlanningContext,
  type ScanContext,
  type VerifyContext,
} from '@devmig/core'
import type { PathMapping, ProjectDescriptor } from '@devmig/model'
import { ScopedFs, noopLogger, stableId, type Exec } from '@devmig/shared'

export interface TestContextOptions {
  homeDir: string
  exec: Exec
  signal?: AbortSignal
  env?: Record<string, string | undefined>
}

export function baseContext(opts: TestContextOptions): BaseContext {
  return {
    homeDir: opts.homeDir,
    claudeConfigDir: path.join(opts.homeDir, '.claude'),
    claudeJsonPath: path.join(opts.homeDir, '.claude.json'),
    env: opts.env ?? { HOME: opts.homeDir },
    exec: opts.exec,
    logger: noopLogger,
    signal: opts.signal ?? new AbortController().signal,
    progress: () => {},
  }
}

export function scanContext(
  opts: TestContextOptions & { allProjects?: ProjectDescriptor[] },
): ScanContext {
  return { ...baseContext(opts), allProjects: opts.allProjects ?? [] }
}

export function backupContext(
  opts: TestContextOptions & { stagingDir: string; relDir: string },
): BackupContext {
  return {
    ...baseContext(opts),
    stagingDir: opts.stagingDir,
    fs: new ScopedFs([opts.stagingDir]),
    payloadPathFor: (rel) => `${opts.relDir}/${rel.split(path.sep).join('/')}`,
    tempDir: opts.stagingDir,
  }
}

export function planningContext(
  opts: TestContextOptions & { payloadRoot: string; mappings?: PathMapping[] },
): RestorePlanningContext {
  const mappings = opts.mappings ?? []
  const mapper = createPathMapper(mappings, { homeDir: opts.homeDir })
  return {
    ...baseContext(opts),
    payloadRoot: opts.payloadRoot,
    mappings,
    mapPath: (p) => mapper.mapPath(p),
    defaultCollisionPolicy: 'skip',
    restoreHints: {},
  }
}

export function restoreContext(
  opts: TestContextOptions & { payloadRoot: string; roots: string[]; mappings?: PathMapping[] },
): RestoreContext {
  const mappings = opts.mappings ?? []
  const mapper = createPathMapper(mappings, { homeDir: opts.homeDir })
  return {
    ...baseContext(opts),
    payloadRoot: opts.payloadRoot,
    mappings,
    mapPath: (p) => mapper.mapPath(p),
    fs: new ScopedFs(opts.roots),
    collisionDecisions: {},
    tempDir: opts.payloadRoot,
  }
}

export function verifyContext(opts: TestContextOptions & { payloadRoot: string }): VerifyContext {
  const mapper = createPathMapper([], { homeDir: opts.homeDir })
  return { ...baseContext(opts), payloadRoot: opts.payloadRoot, mapPath: (p) => mapper.mapPath(p) }
}

export function plainProject(realPath: string, name = path.basename(realPath)): ProjectDescriptor {
  return {
    id: stableId(realPath),
    name,
    originalPath: realPath,
    canonicalPath: realPath,
    realPath,
    detectedProviders: [],
  }
}
