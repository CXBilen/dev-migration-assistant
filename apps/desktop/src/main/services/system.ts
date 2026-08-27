/**
 * OS integration that the renderer may ask for: reveal in Finder, open Terminal, open an allow-listed
 * https link, diagnostics, log folder, backup-name suggestion, home/default folders, path probes.
 * Every path is validated before it reaches an Electron/OS API; every subprocess goes through Exec.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clipboard, shell } from 'electron'
import type { Diagnostics } from '@devmig/model'
import type { CoreServices, Environment } from '@devmig/core'
import { MigrationError, isDirectory, redactObject, type Logger } from '@devmig/shared'
import { validateReadPath } from './destinations'

/** Exact https hosts the app may hand to the OS browser. */
export const EXTERNAL_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'www.github.com',
  'docs.anthropic.com',
  'code.claude.com',
  'electronjs.org',
  'www.electronjs.org',
])

export const TERMINAL_BUNDLE_ID = 'com.apple.Terminal'
const OPEN_BINARY = '/usr/bin/open'

export interface SystemServiceOptions {
  env: Environment
  core: Pick<CoreServices, 'diagnostics'>
  appVersion: string
  electronVersion: string | null
  logsDirectory: () => string
  logFile: () => string
  documentsDirectory: () => string
  logger: Logger
  hostname?: () => string
  now?: () => Date
  platform?: NodeJS.Platform
}

export interface SystemService {
  openInFinder(target: string): Promise<{ ok: boolean }>
  openInTerminal(dir: string): Promise<{ ok: boolean }>
  openExternal(url: string): Promise<{ ok: boolean }>
  diagnostics(): Promise<Diagnostics>
  copyDiagnostics(): Promise<{ ok: boolean }>
  openLogs(): Promise<{ ok: boolean }>
  suggestBackupName(): Promise<{ name: string; defaultDirectory: string }>
  homeDir(): Promise<{ homeDir: string; defaultProjectsDir: string }>
  pathExists(target: string): Promise<{ exists: boolean; isDirectory: boolean; isEmpty: boolean }>
}

/** Returns the parsed URL when it is an https link to an allow-listed host, otherwise null. */
export function allowedExternalUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!EXTERNAL_ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null
  if (url.port !== '') return null
  return url
}

/** Letters, digits and dashes only; the host name itself is never stored in a backup. */
export function machineLabelFromHostname(hostname: string): string {
  const stem = hostname.trim().replace(/\.(local|lan|home)$/i, '')
  const cleaned = stem
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return cleaned.length > 0 ? cleaned : 'Mac'
}

export function formatBackupDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** "<MachineLabel>-Development-<YYYY-MM-DD>" — without extension; the UI appends `.devbackup`. */
export function suggestBackupName(hostname: string, now: Date): string {
  return `${machineLabelFromHostname(hostname)}-Development-${formatBackupDate(now)}`
}

export async function defaultProjectsDir(homeDir: string): Promise<string> {
  for (const candidate of [
    path.join(homeDir, 'Documents', 'GitHub'),
    path.join(homeDir, 'Developer'),
  ]) {
    if (await isDirectory(candidate)) return candidate
  }
  return homeDir
}

export function createSystemService(options: SystemServiceOptions): SystemService {
  const { env, core, logger } = options
  const platform = options.platform ?? process.platform
  const hostname = options.hostname ?? (() => os.hostname())
  const now = options.now ?? (() => new Date())

  async function collect(): Promise<Diagnostics> {
    return core.diagnostics({
      appVersion: options.appVersion,
      electronVersion: options.electronVersion,
      logsDirectory: options.logsDirectory(),
    })
  }

  return {
    async openInFinder(target) {
      const canonical = validateReadPath(target, env.homeDir)
      try {
        await fs.lstat(canonical)
      } catch {
        throw new MigrationError('PATH_NOT_FOUND', `Nothing exists at ${canonical}`, {
          details: { path: canonical },
        })
      }
      shell.showItemInFolder(canonical)
      return { ok: true }
    },

    async openInTerminal(dir) {
      if (platform !== 'darwin') {
        throw new MigrationError('INVALID_INPUT', 'Opening Terminal is only supported on macOS.')
      }
      const canonical = validateReadPath(dir, env.homeDir, 'Directory')
      let real: string
      try {
        real = await fs.realpath(canonical)
      } catch {
        throw new MigrationError('PATH_NOT_FOUND', `Directory not found: ${canonical}`, {
          details: { path: canonical },
        })
      }
      if (!(await isDirectory(real))) {
        throw new MigrationError('NOT_A_DIRECTORY', `Not a directory: ${real}`, {
          details: { path: real },
        })
      }
      if (real.startsWith('-')) {
        throw new MigrationError('INVALID_INPUT', 'Refusing a directory name starting with "-".')
      }
      // `/usr/bin/open -b com.apple.Terminal <dir>` opens a new Terminal window at <dir>. Argument array, no shell.
      await env.exec(OPEN_BINARY, ['-b', TERMINAL_BUNDLE_ID, real], { timeoutMs: 10_000 })
      logger.info('Opened Terminal', { path: real })
      return { ok: true }
    },

    async openExternal(raw) {
      const url = allowedExternalUrl(raw)
      if (!url) {
        throw new MigrationError('PERMISSION_DENIED', 'This link is not on the allow-list.', {
          details: { host: safeHost(raw) },
          hint: 'Only https links to github.com, docs.anthropic.com, code.claude.com and electronjs.org can be opened.',
        })
      }
      await shell.openExternal(url.href)
      return { ok: true }
    },

    diagnostics: collect,

    async copyDiagnostics() {
      const report = redactObject(await collect())
      await clipboard.writeText(JSON.stringify(report, null, 2))
      return { ok: true }
    },

    async openLogs() {
      const file = options.logFile()
      try {
        await fs.stat(file)
        shell.showItemInFolder(file)
        return { ok: true }
      } catch {
        /* no log file yet: open the folder instead */
      }
      const dir = options.logsDirectory()
      await fs.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      if (error) throw new MigrationError('IO_ERROR', `Could not open ${dir}: ${error}`)
      return { ok: true }
    },

    suggestBackupName() {
      return Promise.resolve({
        name: suggestBackupName(hostname(), now()),
        defaultDirectory: options.documentsDirectory(),
      })
    },

    async homeDir() {
      return { homeDir: env.homeDir, defaultProjectsDir: await defaultProjectsDir(env.homeDir) }
    },

    async pathExists(target) {
      const canonical = validateReadPath(target, env.homeDir)
      let st
      try {
        st = await fs.stat(canonical)
      } catch {
        return { exists: false, isDirectory: false, isEmpty: true }
      }
      if (!st.isDirectory()) return { exists: true, isDirectory: false, isEmpty: false }
      try {
        const entries = await fs.readdir(canonical)
        return { exists: true, isDirectory: true, isEmpty: entries.length === 0 }
      } catch {
        return { exists: true, isDirectory: true, isEmpty: false }
      }
    },
  }
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return '(invalid url)'
  }
}
