import { PROGRESS_INTERVAL_MS } from './constants'
import type { ArchiveProgress } from './types'

export interface ProgressReporter {
  report(p: { bytes: number; entries: number; message?: string }, force?: boolean): void
}

/** Throttles progress callbacks to one per PROGRESS_INTERVAL_MS (forced reports always go through). */
export function createProgressReporter(
  onProgress: ((p: ArchiveProgress) => void) | undefined,
  totalBytes?: number,
): ProgressReporter {
  let lastAt = 0
  return {
    report(p, force = false) {
      if (!onProgress) return
      const now = Date.now()
      if (!force && now - lastAt < PROGRESS_INTERVAL_MS) return
      lastAt = now
      const event: ArchiveProgress = {
        bytes: p.bytes,
        entries: p.entries,
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(p.message !== undefined ? { message: p.message } : {}),
      }
      onProgress(event)
    },
  }
}
