/**
 * Launches the BUILT desktop app (apps/desktop/out) under Playwright's Electron driver with the
 * E2E seams enabled: a fake home directory (fixtures from @devmig/test-utils), a JSON queue answering
 * native dialogs, and a private work dir. Nothing here touches the real ~/.claude, ~/Documents or
 * ~/Library — HOME, userData and logs all point into a temp root.
 */
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  createDestinationMachineFixture,
  createSourceMachineFixture,
  makeTempRoot,
  type DestinationMachineFixture,
  type SourceMachineFixture,
  type TempRoot,
} from '../../../packages/test-utils/src/index'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
export const DESKTOP_DIR = path.join(REPO_ROOT, 'apps', 'desktop')
export const MAIN_ENTRY = path.join(DESKTOP_DIR, 'out', 'main', 'index.js')
export const RENDERER_INDEX = path.join(DESKTOP_DIR, 'out', 'renderer', 'index.html')

export type DialogKind = 'directories' | 'file' | 'save' | 'destination'
export interface DialogAnswer {
  kind: DialogKind
  paths: string[]
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  /** Temp root holding the fake home(s), work dir and dialog queue. */
  root: string
  workDir: string
  dialogFile: string
  /** Replaces the dialog queue (FIFO per kind). */
  queueDialogs: (answers: DialogAnswer[]) => Promise<void>
  /** Appends answers to the existing queue. */
  pushDialogs: (answers: DialogAnswer[]) => Promise<void>
  close: () => Promise<void>
}

export interface LaunchOptions {
  /** Fake home directory the app runs against (HOME + Environment overrides). */
  homeDir: string
  claudeConfigDir: string
  claudeJsonPath: string
  /** Temp root the fixtures live under (used for the work dir and the dialog queue). */
  root: string
  dialogs?: DialogAnswer[]
}

/** Path to the Electron binary of apps/desktop (the E2E tests run from the repo root). */
export function electronExecutablePath(): string {
  const require = createRequire(path.join(DESKTOP_DIR, 'package.json'))
  return require('electron') as string
}

export async function assertBuilt(): Promise<void> {
  for (const file of [
    MAIN_ENTRY,
    path.join(DESKTOP_DIR, 'out', 'preload', 'index.cjs'),
    RENDERER_INDEX,
  ]) {
    try {
      await fs.access(file)
    } catch {
      throw new Error(
        `Built app not found (${file}). Run "pnpm build" (or "pnpm verify:e2e") before the E2E suite.`,
      )
    }
  }
}

export async function writeDialogQueue(file: string, answers: DialogAnswer[]): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(answers, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export async function readDialogQueue(file: string): Promise<DialogAnswer[]> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as DialogAnswer[]
  } catch {
    return []
  }
}

export async function launchApp(options: LaunchOptions): Promise<LaunchedApp> {
  await assertBuilt()
  const workDir = path.join(options.root, 'work')
  const dialogFile = path.join(options.root, 'dialogs.json')
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 })
  await writeDialogQueue(dialogFile, options.dialogs ?? [])

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Never let a dev server URL or a real Claude config dir leak into the app under test.
    if (key === 'ELECTRON_RENDERER_URL' || key === 'CLAUDE_CONFIG_DIR' || key === 'NODE_OPTIONS')
      continue
    env[key] = value
  }
  Object.assign(env, {
    HOME: options.homeDir,
    USER: path.basename(options.homeDir),
    LOGNAME: path.basename(options.homeDir),
    DEVMIG_E2E: '1',
    DEVMIG_E2E_DIALOG_FILE: dialogFile,
    DEVMIG_E2E_HOME_DIR: options.homeDir,
    DEVMIG_E2E_CLAUDE_CONFIG_DIR: options.claudeConfigDir,
    DEVMIG_E2E_CLAUDE_JSON_PATH: options.claudeJsonPath,
    DEVMIG_WORK_DIR: workDir,
    ELECTRON_ENABLE_LOGGING: '1',
  })

  // Launch the package directory (like `electron .`): Electron then reads apps/desktop/package.json for
  // `main`, the app name and the version, exactly as the packaged app does.
  const app = await electron.launch({
    executablePath: electronExecutablePath(),
    args: [DESKTOP_DIR],
    cwd: DESKTOP_DIR,
    env,
    timeout: 60_000,
  })
  const page = await app.firstWindow({ timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded')

  return {
    app,
    page,
    root: options.root,
    workDir,
    dialogFile,
    queueDialogs: (answers) => writeDialogQueue(dialogFile, answers),
    pushDialogs: async (answers) => {
      const current = await readDialogQueue(dialogFile)
      await writeDialogQueue(dialogFile, [...current, ...answers])
    },
    close: async () => {
      try {
        await app.close()
      } catch {
        /* already closed */
      }
    },
  }
}

export interface SourceMachine {
  temp: TempRoot
  fixture: SourceMachineFixture
}

export interface DestinationMachine {
  temp: TempRoot
  fixture: DestinationMachineFixture
}

/** "Mac A": alice's fake home with a dirty repo, a sibling worktree, Claude sessions and .env.local. */
export async function buildSourceMachine(
  options: { sessionCount?: number } = {},
): Promise<SourceMachine> {
  const temp = await makeTempRoot('devmig-e2e-src-')
  const fixture = await createSourceMachineFixture(temp.root, {
    ...(options.sessionCount !== undefined ? { sessionCount: options.sessionCount } : {}),
  })
  return { temp, fixture }
}

/** "Mac B": bob's fake home with an empty ~/.claude. */
export async function buildDestinationMachine(): Promise<DestinationMachine> {
  const temp = await makeTempRoot('devmig-e2e-dst-')
  const fixture = await createDestinationMachineFixture(temp.root)
  return { temp, fixture }
}

export function launchOptionsFor(machine: SourceMachine | DestinationMachine): LaunchOptions {
  const home = machine.fixture.home
  return {
    root: machine.temp.root,
    homeDir: home.homeDir,
    claudeConfigDir: home.claudeConfigDir,
    claudeJsonPath: home.claudeJsonPath,
  }
}
