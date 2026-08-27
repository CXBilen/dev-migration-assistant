/**
 * Builds the plaintext payload: an uncompressed POSIX/ustar tar of the staging tree with
 * manifest.json first, checksums.json last and every other entry sorted by path.
 */
import type { Stats } from 'node:fs'
import { Pack, type ReadEntry } from 'tar'
import { MigrationError } from '@devmig/shared'
import { CHECKSUMS_ENTRY, DEFAULT_LIMITS_WITH_DEPTH, MANIFEST_ENTRY } from './constants'
import { walkTree, type TreeEntry } from './tree'

export interface PayloadPlan {
  /** Ordered exactly as they will appear in the tar. */
  entries: TreeEntry[]
  /** Sum of file sizes. */
  fileBytes: number
  /** Lower bound of the tar stream length (512-byte header + padded body per entry + 1024 end). */
  tarBytesEstimate: number
  skipped: string[]
}

export interface PlanPayloadOptions {
  signal?: AbortSignal
  maxPathLength?: number
}

export async function planPayload(
  sourceDir: string,
  opts: PlanPayloadOptions = {},
): Promise<PayloadPlan> {
  const { entries, skipped } = await walkTree(sourceDir, {
    signal: opts.signal,
    maxPathLength: opts.maxPathLength ?? DEFAULT_LIMITS_WITH_DEPTH.maxPathLength,
  })
  const manifest = entries.find((e) => e.path === MANIFEST_ENTRY)
  const checksums = entries.find((e) => e.path === CHECKSUMS_ENTRY)
  if (!manifest || manifest.kind !== 'file') {
    throw new MigrationError(
      'INVALID_INPUT',
      `${MANIFEST_ENTRY} is missing from the source directory.`,
      {
        details: { sourceDir },
      },
    )
  }
  if (!checksums || checksums.kind !== 'file') {
    throw new MigrationError(
      'INVALID_INPUT',
      `${CHECKSUMS_ENTRY} is missing from the source directory.`,
      {
        details: { sourceDir },
      },
    )
  }
  const ordered = [manifest, ...entries.filter((e) => e !== manifest && e !== checksums), checksums]
  let fileBytes = 0
  let tarBytesEstimate = 1024
  for (const e of ordered) {
    fileBytes += e.size
    tarBytesEstimate += 512 + Math.ceil(e.size / 512) * 512
  }
  return { entries: ordered, fileBytes, tarBytesEstimate, skipped }
}

/** node-tar turns repeated inodes into hardlink entries; this cache never remembers anything. */
class NoLinkCache extends Map<`${number}:${number}`, string> {
  override get(): undefined {
    return undefined
  }
  override set(): this {
    return this
  }
}

export interface CreatePackOptions {
  onEntry?: (count: number) => void
}

export function createPayloadPack(
  sourceDir: string,
  plan: PayloadPlan,
  opts: CreatePackOptions = {},
): Pack {
  let count = 0
  const pack = new Pack({
    cwd: sourceDir,
    portable: true,
    follow: false,
    preservePaths: false,
    noDirRecurse: true,
    strict: true,
    linkCache: new NoLinkCache(),
    filter: (_path: string, entry: Stats | ReadEntry) =>
      'isFile' in entry && typeof entry.isFile === 'function'
        ? entry.isFile() || entry.isDirectory()
        : false,
    onWriteEntry: () => {
      count += 1
      opts.onEntry?.(count)
    },
  })
  for (const entry of plan.entries) pack.add(entry.path)
  pack.end()
  return pack
}
