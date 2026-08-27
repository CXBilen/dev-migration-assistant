/**
 * Reusable UI flows over the renderer's data-testid contract (docs/renderer/RENDERER.md).
 */
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { LaunchedApp } from './launch'

export const E2E_PASSWORD = 'correct-horse-battery-staple'

export const LONG = 120_000

/** Ensures the Home screen is shown, navigating via the sidebar when a previous step left the app elsewhere. */
export async function goHome(page: Page): Promise<void> {
  if (!(await page.getByTestId('home').isVisible())) {
    await page.getByTestId('sidebar-home').click()
  }
  await expect(page.getByTestId('home')).toBeVisible()
}

export interface BackupFlowOptions {
  projectPath: string
  outputPath: string
  password?: string
  /** Called on the review screen before continuing (assertions, deselections). */
  onReview?: (page: Page) => Promise<void>
  /** Called on the security screen before starting. */
  onSecurity?: (page: Page) => Promise<void>
}

/** Home → Create Backup → scan → review → security → progress → complete. Returns the file name shown. */
export async function runBackupFlow(
  launched: LaunchedApp,
  options: BackupFlowOptions,
): Promise<string> {
  const { page } = launched
  const password = options.password ?? E2E_PASSWORD
  await goHome(page)
  await launched.queueDialogs([
    { kind: 'directories', paths: [options.projectPath] },
    { kind: 'save', paths: [options.outputPath] },
  ])

  await page.getByTestId('home-create-backup').click()
  await expect(page.getByTestId('screen-projects')).toBeVisible()
  await page.getByTestId('projects-add').first().click()
  await expect(page.getByTestId('projects-item-0')).toContainText(
    path.basename(options.projectPath),
  )
  await page.getByTestId('projects-continue').click()

  await expect(page.getByTestId('screen-scan')).toBeVisible()
  // The scan screen auto-advances to the review once the job completes.
  await expect(page.getByTestId('screen-review')).toBeVisible({ timeout: LONG })
  if (options.onReview) await options.onReview(page)
  await page.getByTestId('review-continue').click()

  await expect(page.getByTestId('screen-security')).toBeVisible()
  if (options.onSecurity) await options.onSecurity(page)
  await page.getByTestId('security-password').fill(password)
  await page.getByTestId('security-password-confirm').fill(password)
  await expect(page.getByTestId('security-label')).not.toHaveValue('')
  await page.getByTestId('security-choose-output').click()
  await expect(page.getByTestId('security-output-path')).toHaveText(options.outputPath)
  await expect(page.getByTestId('security-start')).toBeEnabled()
  await page.getByTestId('security-start').click()

  await expect(page.getByTestId('screen-backup-progress')).toBeVisible()
  await expect(page.getByTestId('backup-complete')).toBeVisible({ timeout: LONG })
  return (await page.getByTestId('backup-file-name').textContent()) ?? ''
}

/** Restore → choose file → password → contents. Stops on the contents screen. */
export async function openBackupInRestore(
  launched: LaunchedApp,
  backupPath: string,
  password: string,
): Promise<void> {
  const { page } = launched
  await goHome(page)
  await launched.queueDialogs([{ kind: 'file', paths: [backupPath] }])
  await page.getByTestId('home-restore-backup').click()
  await expect(page.getByTestId('screen-restore-open')).toBeVisible()
  await page.getByTestId('restore-select-file').click()
  await expect(page.getByTestId('restore-file-name')).toHaveText(path.basename(backupPath))
  await expect(page.getByTestId('restore-format-version')).toContainText('1')
  await expect(page.getByTestId('restore-kdf')).toContainText('argon2id')
  await page.getByTestId('restore-password').fill(password)
  await page.getByTestId('restore-unlock').click()
}
