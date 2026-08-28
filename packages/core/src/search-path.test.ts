import { describe, expect, it } from 'vitest'
import {
  LAUNCHD_DEFAULT_PATH,
  installMethodFor,
  joinSearchPath,
  resolveExecutable,
  resolveSearchPath,
  splitSearchPath,
  userSearchDirs,
  type SearchPathIo,
} from './search-path'

const HOME = '/Users/alice'

/** In-memory io: `dirs` exist, `files` map path -> content, `execs` are executable files. */
function fakeIo(spec: {
  dirs?: string[]
  files?: Record<string, string>
  execs?: string[]
  real?: Record<string, string>
}): SearchPathIo {
  const dirs = new Set(spec.dirs ?? [])
  const files = spec.files ?? {}
  const execs = new Set(spec.execs ?? [])
  const real = spec.real ?? {}
  return {
    isDirectory: (p) => dirs.has(p),
    isExecutableFile: (p) => execs.has(p),
    readTextFile: (p) => (p in files ? files[p]! : null),
    listDirectory: (p) => {
      const prefix = p.endsWith('/') ? p : `${p}/`
      const names = new Set<string>()
      for (const d of [...dirs, ...Object.keys(files), ...execs]) {
        if (d.startsWith(prefix)) names.add(d.slice(prefix.length).split('/')[0]!)
      }
      return [...names].sort()
    },
    realPath: (p) => real[p] ?? p,
  }
}

describe('resolveSearchPath', () => {
  it('keeps the base PATH first, then /etc/paths and /etc/paths.d, then existing user dirs, de-duplicated', () => {
    const io = fakeIo({
      dirs: [
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        '/opt/homebrew/bin',
        `${HOME}/.local/bin`,
        '/opt/X11/bin',
      ],
      files: {
        '/etc/paths': '/usr/local/bin\n/usr/bin\n/bin\n/usr/sbin\n/sbin\n',
        '/etc/paths.d/40-XQuartz': '/opt/X11/bin\n',
      },
    })
    const dirs = resolveSearchPath({ homeDir: HOME, basePath: LAUNCHD_DEFAULT_PATH, io })
    expect(dirs).toEqual([
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/opt/X11/bin',
      '/opt/homebrew/bin',
      `${HOME}/.local/bin`,
    ])
    // /usr/local/bin is listed in /etc/paths but does not exist -> dropped
    expect(dirs).not.toContain('/usr/local/bin')
  })

  it('resolves the nvm default alias to a versions/node/<v>/bin directory', () => {
    const io = fakeIo({
      dirs: [
        '/usr/bin',
        `${HOME}/.nvm/versions/node/v20.11.0/bin`,
        `${HOME}/.nvm/versions/node/v22.4.1/bin`,
        `${HOME}/.nvm/versions/node/v22.10.0/bin`,
      ],
      files: { [`${HOME}/.nvm/alias/default`]: '22\n' },
    })
    expect(userSearchDirs(HOME, io)).toContain(`${HOME}/.nvm/versions/node/v22.10.0/bin`)
    expect(userSearchDirs(HOME, io)).not.toContain(`${HOME}/.nvm/versions/node/v20.11.0/bin`)
  })

  it('falls back to the highest installed nvm version when there is no default alias', () => {
    const io = fakeIo({
      dirs: [`${HOME}/.nvm/versions/node/v18.20.0/bin`, `${HOME}/.nvm/versions/node/v22.4.1/bin`],
    })
    expect(userSearchDirs(HOME, io)).toContain(`${HOME}/.nvm/versions/node/v22.4.1/bin`)
  })

  it('never spawns anything and tolerates an empty machine', () => {
    expect(resolveSearchPath({ homeDir: HOME, basePath: '', io: fakeIo({}) })).toEqual([])
  })
})

describe('splitSearchPath / joinSearchPath', () => {
  it('round-trips and drops empty segments', () => {
    expect(splitSearchPath('/a::/b:')).toEqual(['/a', '/b'])
    expect(splitSearchPath(undefined)).toEqual([])
    expect(joinSearchPath(['/a', '/b'])).toBe('/a:/b')
  })
})

describe('resolveExecutable', () => {
  it('returns the first executable file on the search path, or null', () => {
    const io = fakeIo({ dirs: ['/usr/bin', '/opt/homebrew/bin'], execs: ['/opt/homebrew/bin/gh'] })
    expect(resolveExecutable('gh', '/usr/bin:/opt/homebrew/bin', io)).toBe('/opt/homebrew/bin/gh')
    expect(resolveExecutable('nope', '/usr/bin:/opt/homebrew/bin', io)).toBeNull()
  })

  it('accepts an absolute file only when it is executable and refuses names with separators', () => {
    const io = fakeIo({ execs: ['/usr/bin/open'] })
    expect(resolveExecutable('/usr/bin/open', '', io)).toBe('/usr/bin/open')
    expect(resolveExecutable('/usr/bin/missing', '', io)).toBeNull()
    expect(resolveExecutable('../bin/gh', '/usr/bin', io)).toBeNull()
  })
})

describe('installMethodFor', () => {
  it('classifies the common macOS install locations', () => {
    expect(
      installMethodFor(
        `${HOME}/.local/bin/claude`,
        `${HOME}/.local/share/claude/versions/2.1.250`,
        HOME,
      ),
    ).toBe('native')
    expect(
      installMethodFor('/opt/homebrew/bin/gh', '/opt/homebrew/Cellar/gh/2.96.0/bin/gh', HOME),
    ).toBe('homebrew')
    expect(installMethodFor('/usr/local/bin/gh', '/usr/local/Cellar/gh/2.96.0/bin/gh', HOME)).toBe(
      'homebrew',
    )
    expect(
      installMethodFor(
        `${HOME}/.local/bin/pnpm`,
        `${HOME}/.local/opt/node-v22.22.3-darwin-arm64/lib/node_modules/corepack/dist/pnpm.js`,
        HOME,
      ),
    ).toBe('corepack')
    expect(
      installMethodFor(
        `${HOME}/.local/bin/vercel`,
        `${HOME}/.local/opt/node-v22.22.3-darwin-arm64/lib/node_modules/vercel/dist/index.js`,
        HOME,
      ),
    ).toBe('npm-global')
    expect(
      installMethodFor(
        `${HOME}/.nvm/versions/node/v22.4.1/bin/node`,
        `${HOME}/.nvm/versions/node/v22.4.1/bin/node`,
        HOME,
      ),
    ).toBe('version-manager')
    expect(
      installMethodFor(
        `${HOME}/.volta/bin/node`,
        `${HOME}/.volta/tools/image/node/22.4.1/bin/node`,
        HOME,
      ),
    ).toBe('version-manager')
    expect(installMethodFor('/usr/bin/git', '/usr/bin/git', HOME)).toBe('system')
    expect(
      installMethodFor(
        `${HOME}/.local/bin/node`,
        `${HOME}/.local/opt/node-v22.22.3-darwin-arm64/bin/node`,
        HOME,
      ),
    ).toBe('manual')
    expect(installMethodFor('/Volumes/Tools/bin/x', '/Volumes/Tools/bin/x', HOME)).toBe('unknown')
  })
})
