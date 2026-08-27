import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MigrationError } from '@devmig/shared'
import { assertSafeFixtureRoot } from './temp'

export interface FakeHome {
  /** The fixture root everything lives under. */
  root: string
  userName: string
  /** <root>/Users/<userName> */
  homeDir: string
  /** <homeDir>/.claude */
  claudeConfigDir: string
  /** <homeDir>/.claude.json (beside the config dir, like the real thing). */
  claudeJsonPath: string
  /** <homeDir>/Documents/GitHub */
  projectsDir: string
  /** Environment to hand to providers: HOME/USER point at the fake home, CLAUDE_CONFIG_DIR is deliberately unset. */
  env: Record<string, string | undefined>
}

export interface FakeHomeOptions {
  userName?: string
}

const USER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Creates a fake macOS-style home directory tree under `root` (must be a temp/artifact directory). */
export async function createFakeHome(root: string, opts: FakeHomeOptions = {}): Promise<FakeHome> {
  const safeRoot = assertSafeFixtureRoot(root)
  const userName = opts.userName ?? 'alice'
  if (!USER_NAME_RE.test(userName)) {
    throw new MigrationError('INVALID_INPUT', `Invalid fixture user name: ${userName}`)
  }
  const homeDir = path.join(safeRoot, 'Users', userName)
  const claudeConfigDir = path.join(homeDir, '.claude')
  const claudeJsonPath = path.join(homeDir, '.claude.json')
  const projectsDir = path.join(homeDir, 'Documents', 'GitHub')
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(claudeConfigDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(projectsDir, { recursive: true, mode: 0o700 })
  return {
    root: safeRoot,
    userName,
    homeDir,
    claudeConfigDir,
    claudeJsonPath,
    projectsDir,
    env: { HOME: homeDir, USER: userName, LOGNAME: userName, CLAUDE_CONFIG_DIR: undefined },
  }
}
