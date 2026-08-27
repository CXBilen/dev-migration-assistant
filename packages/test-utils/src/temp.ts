import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MigrationError, canonicalizePath, isPathWithin } from '@devmig/shared'

export interface TempRoot {
  /** Absolute, symlink-resolved path of the temp directory (mode 0700). */
  root: string
  /** Removes the whole tree (read-only git objects are made writable first). Idempotent. */
  cleanup: () => Promise<void>
}

const PREFIX_RE = /^[A-Za-z0-9._-]+$/

/** Creates a private temp directory under os.tmpdir(). The returned root is symlink-resolved (macOS /var -> /private/var). */
export async function makeTempRoot(prefix = 'devmig-test-'): Promise<TempRoot> {
  if (!PREFIX_RE.test(prefix)) {
    throw new MigrationError('INVALID_INPUT', `Invalid temp directory prefix: ${prefix}`)
  }
  const created = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const root = await fs.realpath(created)
  await fs.chmod(root, 0o700)
  let pending: Promise<void> | undefined
  return {
    root,
    cleanup: () => {
      pending ??= removeTempTree(root)
      return pending
    },
  }
}

/** Runs `fn` with a fresh temp root and always cleans up afterwards. */
export async function withTempRoot<T>(
  fn: (root: string) => Promise<T>,
  prefix?: string,
): Promise<T> {
  const tmp = await makeTempRoot(prefix)
  try {
    return await fn(tmp.root)
  } finally {
    await tmp.cleanup()
  }
}

/**
 * Makes every directory and file under `target` writable by the owner without following symlinks.
 * Git writes object files as 0444, which makes some recursive removals fail on strict filesystems.
 */
export async function makeTreeWritable(target: string): Promise<void> {
  const stack: string[] = [target]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let st
    try {
      st = await fs.lstat(current)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    const mode = st.mode & 0o777
    if (st.isDirectory()) {
      if ((mode & 0o700) !== 0o700) await fs.chmod(current, mode | 0o700).catch(() => undefined)
      let entries: string[]
      try {
        entries = await fs.readdir(current)
      } catch {
        continue
      }
      for (const name of entries) stack.push(path.join(current, name))
    } else if ((mode & 0o600) !== 0o600) {
      await fs.chmod(current, mode | 0o600).catch(() => undefined)
    }
  }
}

/**
 * `rm -rf` restricted to os.tmpdir(). Refuses any other location so a mis-built fixture path can
 * never delete real user data. Missing targets are ignored.
 */
export async function removeTempTree(target: string): Promise<void> {
  const tmpRoot = await fs.realpath(os.tmpdir())
  let real: string
  try {
    real = await fs.realpath(target)
  } catch {
    return
  }
  if (real === tmpRoot || !isPathWithin(tmpRoot, real)) {
    throw new MigrationError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      `Refusing to remove a directory outside the OS temp dir: ${real}`,
      { details: { target: real, tmpRoot } },
    )
  }
  await makeTreeWritable(real)
  await fs.rm(real, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * Guards every fixture builder: the root must be absolute and must not be (or live inside) the
 * real home's sensitive locations. Deep temp/artifact directories are allowed.
 */
export function assertSafeFixtureRoot(root: string): string {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    throw new MigrationError('INVALID_INPUT', 'Fixture root must be a non-empty path')
  }
  if (!path.isAbsolute(root)) {
    throw new MigrationError('INVALID_INPUT', `Fixture root must be absolute: ${root}`)
  }
  const canonical = canonicalizePath(root)
  const home = canonicalizePath(os.homedir())
  if (canonical === path.parse(canonical).root || canonical === home) {
    throw new MigrationError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      `Refusing to use ${canonical} as a fixture root`,
    )
  }
  const forbiddenSubtrees = ['.claude', '.ssh', 'Library'].map((p) => path.join(home, p))
  for (const dir of forbiddenSubtrees) {
    if (isPathWithin(dir, canonical)) {
      throw new MigrationError(
        'PATH_OUTSIDE_ALLOWED_ROOT',
        `Refusing to build fixtures inside a real user directory: ${canonical}`,
        { details: { forbidden: dir } },
      )
    }
  }
  const githubDir = path.join(home, 'Documents', 'GitHub')
  if (canonical === githubDir || path.dirname(canonical) === githubDir) {
    throw new MigrationError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      `Refusing to build fixtures directly inside a real projects directory: ${canonical}`,
    )
  }
  for (const name of ['.claude.json', '.gitconfig']) {
    if (canonical === path.join(home, name)) {
      throw new MigrationError('PATH_OUTSIDE_ALLOWED_ROOT', `Refusing to touch ${canonical}`)
    }
  }
  return canonical
}
