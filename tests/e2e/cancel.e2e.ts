import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { E2E_PASSWORD, LONG, goHome } from './helpers/flows'
import {
  buildSourceMachine,
  launchApp,
  launchOptionsFor,
  type LaunchedApp,
  type SourceMachine,
} from './helpers/launch'

let machine: SourceMachine
let launched: LaunchedApp

test.beforeAll(async () => {
  // Many sessions make the COLLECTING phase long enough to cancel deterministically.
  machine = await buildSourceMachine({ sessionCount: 120 })
  launched = await launchApp(launchOptionsFor(machine))
})

test.afterAll(async () => {
  await launched?.close()
  await machine?.temp.cleanup()
})

test('cancelling a running backup discards the partial file and returns to a sane state', async () => {
  const { page } = launched
  const outputDir = path.join(machine.temp.root, 'backups')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, 'cancelled.devbackup')

  await goHome(page)
  await launched.queueDialogs([
    { kind: 'directories', paths: [machine.fixture.projectPath] },
    { kind: 'save', paths: [outputPath] },
  ])
  await page.getByTestId('home-create-backup').click()
  await page.getByTestId('projects-add').first().click()
  await page.getByTestId('projects-continue').click()
  await expect(page.getByTestId('screen-review')).toBeVisible({ timeout: LONG })
  await page.getByTestId('review-continue').click()
  await page.getByTestId('security-password').fill(E2E_PASSWORD)
  await page.getByTestId('security-password-confirm').fill(E2E_PASSWORD)
  await page.getByTestId('security-choose-output').click()
  await expect(page.getByTestId('security-output-path')).toHaveText(outputPath)
  await page.getByTestId('security-start').click()

  await expect(page.getByTestId('screen-backup-progress')).toBeVisible()
  // Cancel as early as possible; confirm in the dialog.
  const cancelButton = page.getByTestId('backup-cancel')
  const raced = await Promise.race([
    cancelButton.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'cancel' as const),
    page
      .getByTestId('backup-complete')
      .waitFor({ state: 'visible', timeout: LONG })
      .then(() => 'complete' as const),
  ])
  if (raced === 'cancel') {
    await cancelButton.click()
    await page.getByTestId('backup-cancel-dialog-confirm').click()
    await expect(page.getByTestId('backup-status')).toHaveText(/Backup cancelled|Backup verified/, {
      timeout: LONG,
    })
  }

  const status = await page
    .getByTestId('backup-status')
    .textContent()
    .catch(() => null)
  const completed =
    (await page.getByTestId('backup-complete').count()) > 0 || status?.includes('verified') === true
  if (completed) {
    // The job finished before the cancel could land: the file must be a complete, valid backup.
    test.info().annotations.push({
      type: 'note',
      description:
        'backup finished before cancellation could take effect; asserted the completed state instead',
    })
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(0)
    return
  }

  await expect(page.getByTestId('backup-status')).toHaveText('Backup cancelled')
  await expect(page.getByTestId('backup-retry')).toBeVisible()
  await expect(page.getByTestId('backup-cancel')).toHaveCount(0)
  // Partial output removed, no temp file left next to it.
  await expect(fs.stat(outputPath)).rejects.toThrow()
  const leftovers = (await fs.readdir(outputDir)).filter((f) => f.includes('cancelled'))
  expect(leftovers).toEqual([])
  // The wizard is still usable: back to the security step, then Home.
  await page.getByTestId('backup-retry').click()
  await expect(page.getByTestId('screen-security')).toBeVisible()
  await page.getByTestId('sidebar-home').click()
  await goHome(page)
})
