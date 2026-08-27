import { promises as fs, type Dirent, type Stats } from 'node:fs'
import path from 'node:path'
import { MigrationError } from './errors'
import { canonicalizePath, isPathWithin } from './paths'

/**
 * A filesystem facade bound to an explicit allow-list of roots.
 * Every mutating call verifies (a) the canonical target is inside a root and
 * (b) the nearest existing ancestor's real path is still inside a root (symlink escape protection).
 * Providers receive one of these instead of raw `fs` so they physically cannot write outside the plan.
 */
export class ScopedFs {
  readonly roots: string[]

  constructor(roots: string[]) {
    if (roots.length === 0) throw new Error('ScopedFs requires at least one root')
    this.roots = roots.map((r) => canonicalizePath(r))
  }

  withRoots(extra: string[]): ScopedFs {
    return new ScopedFs([...this.roots, ...extra])
  }

  private rootFor(target: string): string | undefined {
    const t = canonicalizePath(target)
    return this.roots.find((r) => isPathWithin(r, t))
  }

  /** Throws PATH_OUTSIDE_ALLOWED_ROOT unless target is within a root, including after symlink resolution of existing ancestors. */
  async assertAllowed(target: string): Promise<string> {
    const canonical = canonicalizePath(target)
    const root = this.rootFor(canonical)
    if (!root) {
      throw new MigrationError(
        'PATH_OUTSIDE_ALLOWED_ROOT',
        `Refusing to touch a path outside the approved destination: ${canonical}`,
        {
          details: { path: canonical, roots: this.roots },
        },
      )
    }
    // Resolve the nearest existing ancestor and make sure symlinks did not redirect us elsewhere.
    let probe = canonical
    for (;;) {
      try {
        const real = await fs.realpath(probe)
        const realRoot = await fs.realpath(root).catch(() => root)
        if (!isPathWithin(realRoot, real) && !this.roots.some((r) => isPathWithin(r, real))) {
          throw new MigrationError(
            'PATH_OUTSIDE_ALLOWED_ROOT',
            `Symlink escapes the approved destination: ${canonical}`,
            {
              details: { path: canonical, resolved: real },
            },
          )
        }
        break
      } catch (err) {
        if (err instanceof MigrationError) throw err
        const parent = path.dirname(probe)
        if (parent === probe) break
        probe = parent
      }
    }
    return canonical
  }

  isAllowed(target: string): boolean {
    return this.rootFor(target) !== undefined
  }

  // ---- read (unrestricted reads are fine; reads never damage anything) ----
  async readFile(p: string): Promise<Buffer> {
    return fs.readFile(p)
  }
  async readText(p: string): Promise<string> {
    return fs.readFile(p, 'utf8')
  }
  async readdir(p: string): Promise<Dirent[]> {
    return fs.readdir(p, { withFileTypes: true })
  }
  async stat(p: string): Promise<Stats> {
    return fs.stat(p)
  }
  async lstat(p: string): Promise<Stats> {
    return fs.lstat(p)
  }
  async exists(p: string): Promise<boolean> {
    try {
      await fs.lstat(p)
      return true
    } catch {
      return false
    }
  }

  // ---- write (guarded) ----
  async mkdir(p: string, mode = 0o700): Promise<void> {
    const target = await this.assertAllowed(p)
    await fs.mkdir(target, { recursive: true, mode })
  }
  async writeFile(p: string, data: Buffer | string, mode = 0o600): Promise<void> {
    const target = await this.assertAllowed(p)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, data, { mode })
  }
  /** Atomic write: temp file in the same directory + fsync + rename. */
  async writeFileAtomic(p: string, data: Buffer | string, mode = 0o600): Promise<void> {
    const target = await this.assertAllowed(p)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const tmp = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
    )
    const handle = await fs.open(tmp, 'w', mode)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, target)
  }
  async copyFile(src: string, dest: string): Promise<void> {
    const target = await this.assertAllowed(dest)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(src, target)
  }
  /** Recursive copy that never follows symlinks (symlinks are skipped and reported). Returns files copied and skipped symlinks. */
  async copyDir(
    src: string,
    dest: string,
    opts: { filter?: (rel: string, dirent: Dirent) => boolean } = {},
  ): Promise<{ files: number; bytes: number; skippedSymlinks: string[] }> {
    const target = await this.assertAllowed(dest)
    const stats = { files: 0, bytes: 0, skippedSymlinks: [] as string[] }
    const walk = async (from: string, to: string, rel: string): Promise<void> => {
      await fs.mkdir(to, { recursive: true })
      for (const entry of await fs.readdir(from, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        if (opts.filter && !opts.filter(childRel, entry)) continue
        const fromPath = path.join(from, entry.name)
        const toPath = path.join(to, entry.name)
        if (entry.isSymbolicLink()) {
          stats.skippedSymlinks.push(childRel)
          continue
        }
        if (entry.isDirectory()) {
          await walk(fromPath, toPath, childRel)
        } else if (entry.isFile()) {
          await fs.copyFile(fromPath, toPath)
          stats.files += 1
          stats.bytes += (await fs.stat(fromPath)).size
        }
      }
    }
    await walk(src, target, '')
    return stats
  }
  async rename(from: string, to: string): Promise<void> {
    await this.assertAllowed(from)
    const target = await this.assertAllowed(to)
    await fs.rename(from, target)
  }
  async rm(p: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const target = await this.assertAllowed(p)
    await fs.rm(target, { recursive: opts.recursive ?? false, force: true })
  }
}
