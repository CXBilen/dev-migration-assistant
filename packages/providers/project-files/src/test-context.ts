/**
 * Test-only context builders. Everything points at caller-provided temp directories; nothing here
 * ever defaults to the real home directory.
 */
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
import type { CollisionPolicy, PathMapping, ProjectDescriptor } from '@devmig/model'
import { ScopedFs, noopLogger, realExec, stableId, type Exec } from '@devmig/shared'

export interface TestContextOptions {
  homeDir: string
  exec?: Exec
  signal?: AbortSignal
  env?: Record<string, string | undefined>
}

export function baseContext(opts: TestContextOptions): BaseContext {
  return {
    homeDir: opts.homeDir,
    claudeConfigDir: path.join(opts.homeDir, '.claude'),
    claudeJsonPath: path.join(opts.homeDir, '.claude.json'),
    env: opts.env ?? { HOME: opts.homeDir },
    exec: opts.exec ?? realExec,
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
  opts: TestContextOptions & { stagingDir: string; tempDir: string; relDir?: string },
): BackupContext {
  const relDir = opts.relDir ?? 'projects/test/project-files'
  return {
    ...baseContext(opts),
    stagingDir: opts.stagingDir,
    fs: new ScopedFs([opts.stagingDir]),
    payloadPathFor: (rel) => `${relDir}/${rel.split(path.sep).join('/')}`,
    tempDir: opts.tempDir,
  }
}

export function planningContext(
  opts: TestContextOptions & {
    payloadRoot: string
    mappings: PathMapping[]
    defaultCollisionPolicy?: CollisionPolicy
  },
): RestorePlanningContext {
  const mapper = createPathMapper(opts.mappings, { homeDir: opts.homeDir })
  return {
    ...baseContext(opts),
    payloadRoot: opts.payloadRoot,
    mappings: opts.mappings,
    mapPath: (p) => mapper.mapPath(p),
    defaultCollisionPolicy: opts.defaultCollisionPolicy ?? 'skip',
    restoreHints: {},
  }
}

export function restoreContext(
  opts: TestContextOptions & {
    payloadRoot: string
    mappings: PathMapping[]
    roots: string[]
    tempDir: string
    collisionDecisions?: Record<string, CollisionPolicy>
    /** Override the ScopedFs (tests inject failing implementations). */
    fs?: ScopedFs
  },
): RestoreContext {
  const mapper = createPathMapper(opts.mappings, { homeDir: opts.homeDir })
  return {
    ...baseContext(opts),
    payloadRoot: opts.payloadRoot,
    mappings: opts.mappings,
    mapPath: (p) => mapper.mapPath(p),
    fs: opts.fs ?? new ScopedFs(opts.roots),
    collisionDecisions: opts.collisionDecisions ?? {},
    tempDir: opts.tempDir,
  }
}

export function verifyContext(
  opts: TestContextOptions & { payloadRoot: string; mappings: PathMapping[] },
): VerifyContext {
  const mapper = createPathMapper(opts.mappings, { homeDir: opts.homeDir })
  return { ...baseContext(opts), payloadRoot: opts.payloadRoot, mapPath: (p) => mapper.mapPath(p) }
}

/** A non-git ProjectDescriptor for a directory (id derived like the real scanner does). */
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
