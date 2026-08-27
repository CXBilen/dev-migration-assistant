/**
 * Paths the user picked through a native dialog (or the E2E seam) during this app session.
 * Write destinations sent back by the renderer must be members of this set: the renderer may only
 * echo a path it was handed, never invent one.
 */
import { canonicalizePath } from '@devmig/shared'

const MAX_ENTRIES = 512

export class ApprovedPaths {
  private readonly paths = new Set<string>()

  constructor(private readonly homeDir: string) {}

  approve(p: string): string {
    const canonical = canonicalizePath(p, this.homeDir)
    this.paths.delete(canonical)
    this.paths.add(canonical)
    while (this.paths.size > MAX_ENTRIES) {
      const oldest = this.paths.values().next().value
      if (oldest === undefined) break
      this.paths.delete(oldest)
    }
    return canonical
  }

  has(p: string): boolean {
    if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return false
    return this.paths.has(canonicalizePath(p, this.homeDir))
  }

  size(): number {
    return this.paths.size
  }
}
