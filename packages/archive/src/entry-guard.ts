/**
 * Validates every tar entry before anything is done with it (extract, verify and inspect share it).
 * The archive is untrusted input: fail closed on anything our own writer never produces.
 */
import { isSafeArchivePath } from '@devmig/shared'
import type { ReadEntry } from 'tar'
import {
  CHECKSUMS_ENTRY,
  DEFAULT_LIMITS_WITH_DEPTH,
  EXTRACT_TEMP_SUFFIX,
  MANIFEST_ENTRY,
  MAX_CHECKSUMS_BYTES,
  MAX_MANIFEST_BYTES,
} from './constants'
import { entryRejected, invalid, limitExceeded } from './errors'
import type { ExtractionLimits } from './types'

export type AcceptedKind = 'File' | 'Directory'

export interface AcceptedEntry {
  /** Normalised POSIX relative path (trailing "/" of directories removed). */
  path: string
  kind: AcceptedKind
  size: number
  isManifest: boolean
  isChecksums: boolean
}

export function resolveLimits(partial?: Partial<ExtractionLimits>): Required<ExtractionLimits> {
  return {
    maxTotalBytes: partial?.maxTotalBytes ?? DEFAULT_LIMITS_WITH_DEPTH.maxTotalBytes,
    maxEntries: partial?.maxEntries ?? DEFAULT_LIMITS_WITH_DEPTH.maxEntries,
    maxEntryBytes: partial?.maxEntryBytes ?? DEFAULT_LIMITS_WITH_DEPTH.maxEntryBytes,
    maxPathLength: partial?.maxPathLength ?? DEFAULT_LIMITS_WITH_DEPTH.maxPathLength,
    maxDepth: partial?.maxDepth ?? DEFAULT_LIMITS_WITH_DEPTH.maxDepth,
  }
}

/** Key used to detect duplicates on case-insensitive, normalisation-insensitive filesystems (APFS). */
function collisionKey(p: string): string {
  return p.normalize('NFC').toLowerCase()
}

export class EntryGuard {
  readonly limits: Required<ExtractionLimits>
  entries = 0
  bytes = 0
  private readonly fileKeys = new Set<string>()
  private readonly dirKeys = new Set<string>()
  private sawManifest = false
  private sawChecksums = false

  constructor(limits?: Partial<ExtractionLimits>) {
    this.limits = resolveLimits(limits)
  }

  /** Validates the next entry in archive order. Throws a MigrationError when it must be rejected. */
  accept(rawPath: string, type: ReadEntry['type'], size: number): AcceptedEntry {
    if (this.sawChecksums) {
      throw invalid(`Entry after ${CHECKSUMS_ENTRY}: ${describe(rawPath)}`, { path: rawPath })
    }
    if (type !== 'File' && type !== 'Directory') {
      throw entryRejected(`Unsupported entry type "${type}" for ${describe(rawPath)}`, {
        path: rawPath,
        type,
      })
    }
    const kind: AcceptedKind = type
    let p = rawPath
    if (kind === 'Directory' && p.endsWith('/')) p = p.slice(0, -1)
    if (typeof p !== 'string' || p.length === 0) {
      throw entryRejected('Entry has an empty path.')
    }
    if (Buffer.byteLength(p, 'utf8') > this.limits.maxPathLength) {
      throw limitExceeded(`Entry path longer than ${this.limits.maxPathLength} bytes.`, {
        path: p.slice(0, 200),
        max: this.limits.maxPathLength,
      })
    }
    if (!isSafeArchivePath(p) || p.includes('\\') || p.includes('/./') || p.startsWith('./')) {
      throw entryRejected(`Unsafe entry path: ${describe(p)}`, { path: p })
    }
    const segments = p.split('/')
    if (segments.length > this.limits.maxDepth) {
      throw limitExceeded(`Entry nested deeper than ${this.limits.maxDepth} levels.`, {
        path: p,
        max: this.limits.maxDepth,
      })
    }
    if (segments.some((s) => s.endsWith(EXTRACT_TEMP_SUFFIX))) {
      throw entryRejected(`Reserved path segment in entry: ${describe(p)}`, { path: p })
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw entryRejected(`Invalid size for ${describe(p)}`, { path: p, size })
    }
    if (kind === 'Directory' && size !== 0) {
      throw entryRejected(`Directory entry with a body: ${describe(p)}`, { path: p, size })
    }
    const isManifest = p === MANIFEST_ENTRY
    const isChecksums = p === CHECKSUMS_ENTRY
    if (this.entries === 0) {
      if (!isManifest || kind !== 'File') {
        throw invalid(`The first entry must be ${MANIFEST_ENTRY}, got ${describe(p)}`, { path: p })
      }
    } else if (isManifest) {
      throw entryRejected(`Duplicate ${MANIFEST_ENTRY} entry.`, { path: p })
    }
    if (isManifest && size > MAX_MANIFEST_BYTES) {
      throw limitExceeded(`${MANIFEST_ENTRY} is larger than ${MAX_MANIFEST_BYTES} bytes.`, { size })
    }
    if (isChecksums) {
      if (kind !== 'File') throw entryRejected(`${CHECKSUMS_ENTRY} must be a file.`)
      if (size > MAX_CHECKSUMS_BYTES) {
        throw limitExceeded(`${CHECKSUMS_ENTRY} is larger than ${MAX_CHECKSUMS_BYTES} bytes.`, {
          size,
        })
      }
    }
    if (this.entries + 1 > this.limits.maxEntries) {
      throw limitExceeded(`The archive has more than ${this.limits.maxEntries} entries.`, {
        max: this.limits.maxEntries,
      })
    }
    if (size > this.limits.maxEntryBytes) {
      throw limitExceeded(`Entry larger than ${this.limits.maxEntryBytes} bytes: ${describe(p)}`, {
        path: p,
        size,
        max: this.limits.maxEntryBytes,
      })
    }
    if (this.bytes + size > this.limits.maxTotalBytes) {
      throw limitExceeded(`The archive expands to more than ${this.limits.maxTotalBytes} bytes.`, {
        max: this.limits.maxTotalBytes,
      })
    }
    // Duplicate / conflicting paths (case- and normalisation-insensitive): a later entry would
    // silently replace an earlier one or race against it.
    const key = collisionKey(p)
    if (this.fileKeys.has(key) || (kind === 'File' && this.dirKeys.has(key))) {
      throw entryRejected(`Duplicate or conflicting entry path: ${describe(p)}`, { path: p })
    }
    if (kind === 'Directory' && this.dirKeys.has(key)) {
      throw entryRejected(`Duplicate directory entry: ${describe(p)}`, { path: p })
    }
    let ancestor = ''
    for (let i = 0; i < segments.length - 1; i += 1) {
      ancestor = ancestor ? `${ancestor}/${segments[i] as string}` : (segments[i] as string)
      const ancestorKey = collisionKey(ancestor)
      if (this.fileKeys.has(ancestorKey)) {
        throw entryRejected(`Entry path passes through a file: ${describe(p)}`, { path: p })
      }
      this.dirKeys.add(ancestorKey)
    }
    if (kind === 'File') this.fileKeys.add(key)
    else this.dirKeys.add(key)

    this.entries += 1
    this.bytes += size
    if (isManifest) this.sawManifest = true
    if (isChecksums) this.sawChecksums = true
    return { path: p, kind, size, isManifest, isChecksums }
  }

  /** Called once the tar stream ended: manifest.json first and checksums.json last are mandatory. */
  finish(): void {
    if (!this.sawManifest) throw invalid(`The archive contains no ${MANIFEST_ENTRY}.`)
    if (!this.sawChecksums) throw invalid(`The archive does not end with ${CHECKSUMS_ENTRY}.`)
  }
}

function describe(p: string): string {
  const printable = p.replace(/[^\x20-\x7e]/g, '?')
  return JSON.stringify(printable.length > 120 ? `${printable.slice(0, 120)}…` : printable)
}
