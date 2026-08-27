import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { goHome } from './helpers/flows'
import {
  DESKTOP_DIR,
  RENDERER_INDEX,
  buildDestinationMachine,
  launchApp,
  launchOptionsFor,
  type DestinationMachine,
  type LaunchedApp,
} from './helpers/launch'

let machine: DestinationMachine
let launched: LaunchedApp

test.beforeAll(async () => {
  machine = await buildDestinationMachine()
  launched = await launchApp(launchOptionsFor(machine))
})

test.afterAll(async () => {
  await launched?.close()
  await machine?.temp.cleanup()
})

test('launches with the real bridge and shows Home', async () => {
  const { page } = launched
  await goHome(page)
  await expect(page.getByTestId('home-mock-badge')).toHaveCount(0)
  await expect(page.getByTestId('home-footer')).toContainText('Local only')
  const meta = await page.evaluate(() => window.devMigration.meta)
  const pkg = JSON.parse(await fs.readFile(path.join(DESKTOP_DIR, 'package.json'), 'utf8')) as {
    version: string
  }
  expect(meta).toEqual({ appVersion: pkg.version, platform: 'darwin', isE2E: true })
})

test('diagnostics shows the app version and every provider', async () => {
  const { page } = launched
  await goHome(page)
  await page.getByTestId('home-diagnostics').click()
  await expect(page.getByTestId('screen-diagnostics')).toBeVisible()
  const pkg = JSON.parse(await fs.readFile(path.join(DESKTOP_DIR, 'package.json'), 'utf8')) as {
    version: string
  }
  await expect(page.getByTestId('diag-app-version')).toContainText(pkg.version)
  await expect(page.getByTestId('diag-format-version')).toContainText('version 1')
  for (const id of ['git', 'project-files', 'claude-code', 'runtime']) {
    await expect(page.getByTestId(`diag-provider-${id}`)).toBeVisible({ timeout: 60_000 })
  }
  await expect(page.getByTestId('diag-provider-git')).toContainText('available')
  await expect(page.getByTestId('diag-claude-dir')).toContainText('exists')
  await page.getByTestId('wizard-back').click()
  await goHome(page)
})

test('renderer is sandboxed: no Node globals, window.open denied', async () => {
  const { page } = launched
  await goHome(page)
  const globals = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    electron: typeof (window as unknown as { electron?: unknown }).electron,
    ipc: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
    bridgeKeys: Object.keys(window.devMigration).sort(),
    opened: window.open('https://example.com', '_blank'),
  }))
  expect(globals.require).toBe('undefined')
  expect(globals.process).toBe('undefined')
  expect(globals.electron).toBe('undefined')
  expect(globals.ipc).toBe('undefined')
  expect(globals.opened).toBeNull()
  expect(globals.bridgeKeys).toEqual(['backups', 'jobs', 'meta', 'projects', 'restore', 'system'])
  expect(launched.app.windows()).toHaveLength(1)
})

test('IPC rejects forged calls (schema) and unlisted links (allow-list)', async () => {
  const { page } = launched
  const schemaError = await page.evaluate(() =>
    window.devMigration.projects
      .scan({ paths: [] })
      .then(() => null)
      .catch((err: { code?: string }) => err.code ?? null),
  )
  expect(schemaError).toBe('INVALID_INPUT')
  const linkError = await page.evaluate(() =>
    window.devMigration.system
      .openExternal('https://evil.example.com/')
      .then(() => null)
      .catch((err: { code?: string }) => err.code ?? null),
  )
  expect(linkError).toBe('PERMISSION_DENIED')
})

test('packaged index.html carries a strict CSP without localhost origins', async () => {
  const html = await fs.readFile(RENDERER_INDEX, 'utf8')
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html)
  expect(meta).not.toBeNull()
  const csp = meta![1]!
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain("frame-src 'none'")
  expect(csp).toContain("base-uri 'none'")
  expect(csp).not.toContain('localhost')
  expect(csp).not.toMatch(/script-src[^;]*(unsafe|data:|http)/)
})

test('navigation away from the bundled page is blocked (runs last)', async () => {
  const { page } = launched
  await goHome(page)
  const before = await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.getURL(),
  )
  expect(before.startsWith('file://')).toBe(true)
  await page.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await new Promise((resolve) => setTimeout(resolve, 750))
  const after = await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.getURL(),
  )
  expect(after).toBe(before)
  expect(launched.app.windows()).toHaveLength(1)
})
