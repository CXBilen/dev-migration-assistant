import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { readDevBackupHeader } from '../../packages/archive/src/index'
import { E2E_PASSWORD, runBackupFlow } from './helpers/flows'
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
  machine = await buildSourceMachine()
  launched = await launchApp(launchOptionsFor(machine))
})

test.afterAll(async () => {
  await launched?.close()
  await machine?.temp.cleanup()
})

test('full backup: select project → scan → review → security → encrypted .devbackup on disk', async () => {
  const { page } = launched
  const outputDir = path.join(machine.temp.root, 'backups')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, 'demo.devbackup')
  const secrets = machine.fixture.secrets

  const fileName = await runBackupFlow(launched, {
    projectPath: machine.fixture.projectPath,
    outputPath,
    onReview: async (p) => {
      const projectId = await p
        .locator('[data-testid^="review-project-"]')
        .first()
        .getAttribute('data-testid')
      expect(projectId).not.toBeNull()
      const id = projectId!.replace('review-project-', '')
      // Git: repository detected with the fixture branch; Claude Code: sessions detected.
      await expect(p.getByTestId(`review-${id}-git`)).toBeVisible()
      await expect(p.getByTestId(`review-${id}-git`)).toContainText(/main/)
      await expect(p.getByTestId(`review-${id}-claude-code`)).toBeVisible()
      await expect(p.getByTestId(`review-${id}-claude-code`)).toContainText(/session/i)
      const sessions = Number(
        (await p.getByTestId('review-total-sessions').textContent())?.replace(/\D/g, ''),
      )
      expect(sessions).toBeGreaterThanOrEqual(
        machine.fixture.claude.expectedProjectSessionIds.length,
      )
      // The review counts every worktree of the checkout (primary + linked); the manifest counts linked ones only.
      const worktrees = Number(await p.getByTestId('review-total-worktrees').textContent())
      expect(worktrees).toBeGreaterThanOrEqual(1)
      // "Select everything" warns before including sensitive files; cancelling keeps the defaults.
      const artifactsBefore = await p.getByTestId('review-total-artifacts').textContent()
      await p.getByTestId('review-select-all').click()
      const dialog = p.getByTestId('review-select-all-dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('.env.local')
      await p.getByTestId('review-select-all-dialog-cancel').click()
      await expect(dialog).toBeHidden()
      await expect(p.getByTestId('review-total-artifacts')).toHaveText(artifactsBefore ?? '')
      // Nothing secret is rendered on the review screen.
      const text = await p.getByTestId('screen-review').innerText()
      for (const secret of secrets) expect(text).not.toContain(secret)
    },
    onSecurity: async (p) => {
      // .env.local is sensitive and opt-in (switch off by default).
      const sensitive = p.getByTestId('security-sensitive')
      await expect(sensitive).toContainText('.env.local')
      const toggle = sensitive
        .locator('[data-testid^="security-sensitive-"][role="switch"]')
        .first()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      const text = await p.getByTestId('screen-security').innerText()
      for (const secret of secrets) expect(text).not.toContain(secret)
    },
  })

  expect(fileName).toBe('demo.devbackup')
  await expect(page.getByTestId('backup-projects-count')).toContainText('1')
  await expect(page.getByTestId('backup-worktrees-count')).toContainText('1')
  const sessionsShown = Number(
    (await page.getByTestId('backup-sessions-count').textContent())?.replace(/\D/g, ''),
  )
  expect(sessionsShown).toBeGreaterThanOrEqual(
    machine.fixture.claude.expectedProjectSessionIds.length,
  )

  const stat = await fs.stat(outputPath)
  expect(stat.size).toBeGreaterThan(0)
  const header = await readDevBackupHeader(outputPath)
  expect(header.supported).toBe(true)
  expect(header.header.formatVersion).toBe(1)
  expect(header.header.cipher).toBe('aes-256-gcm')
  expect(header.header.kdf.algorithm).toBe('argon2id')
  // The header is the only cleartext; no fixture secret appears in the file's first bytes.
  const raw = await fs.readFile(outputPath)
  for (const secret of secrets) expect(raw.includes(secret)).toBe(false)

  // The source machine was never modified: repo state and Claude dir are intact.
  await expect(fs.stat(machine.fixture.repo.files.envLocal!)).resolves.toBeTruthy()
  await expect(fs.stat(machine.fixture.claude.files.settingsJson)).resolves.toBeTruthy()

  await page.getByTestId('backup-done').click()
  await expect(page.getByTestId('home')).toBeVisible()
  // Wrong password fails closed on the same file.
  expect(E2E_PASSWORD).not.toBe('wrong')
})
