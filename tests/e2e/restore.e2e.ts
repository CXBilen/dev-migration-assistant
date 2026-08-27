import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { realExec } from '../../packages/shared/src/index'
import { encodeClaudeProjectDir, readJsonl } from '../../packages/test-utils/src/index'
import { E2E_PASSWORD, LONG, openBackupInRestore, runBackupFlow } from './helpers/flows'
import {
  buildDestinationMachine,
  buildSourceMachine,
  launchApp,
  launchOptionsFor,
  type DestinationMachine,
  type LaunchedApp,
  type SourceMachine,
} from './helpers/launch'

let source: SourceMachine
let destination: DestinationMachine
let backupPath: string
let launched: LaunchedApp

test.beforeAll(async () => {
  // Mac A: create the backup through the UI, then quit that app instance.
  source = await buildSourceMachine()
  const backupDir = path.join(source.temp.root, 'backups')
  await fs.mkdir(backupDir, { recursive: true })
  backupPath = path.join(backupDir, 'alice.devbackup')
  const sourceApp = await launchApp(launchOptionsFor(source))
  try {
    await runBackupFlow(sourceApp, {
      projectPath: source.fixture.projectPath,
      outputPath: backupPath,
    })
  } finally {
    await sourceApp.close()
  }
  // Mac B: a different user with an empty ~/.claude.
  destination = await buildDestinationMachine()
  launched = await launchApp(launchOptionsFor(destination))
})

test.afterAll(async () => {
  await launched?.close()
  await destination?.temp.cleanup()
  await source?.temp.cleanup()
})

test('a wrong password shows the inline error and never leaves the Open screen', async () => {
  const { page } = launched
  await openBackupInRestore(launched, backupPath, 'definitely-not-the-password')
  await expect(page.getByRole('alert')).toContainText('That password did not unlock this backup.')
  await expect(page.getByTestId('screen-restore-open')).toBeVisible()
  await page.getByTestId('wizard-back').click()
  await expect(page.getByTestId('home')).toBeVisible()
})

test('full restore to a new user and path: repo, worktree, sessions with rewritten cwd and intact prose', async () => {
  const { page } = launched
  const bobHome = destination.fixture.home.homeDir
  const newProjectPath = path.join(bobHome, 'Developer', 'demo')

  await openBackupInRestore(launched, backupPath, E2E_PASSWORD)
  await expect(page.getByTestId('screen-restore-contents')).toBeVisible({ timeout: LONG })
  await expect(page.getByTestId('contents-summary')).toContainText(/item/)
  await expect(page.getByTestId('contents-tools')).toBeVisible()
  await page.getByTestId('contents-continue').click()

  // Locations: map the project to <bob home>/Developer/demo (typed path, validated in main).
  await expect(page.getByTestId('screen-restore-mapping')).toBeVisible()
  await page.getByTestId('mapping-input-0').fill(newProjectPath)
  await expect(page.getByTestId('mapping-summary')).toContainText('1 project will be remapped')
  await expect(page.getByTestId('mapping-remap-0')).toContainText(
    /Claude sessions require safe path remapping/,
  )
  await expect(page.getByTestId('mapping-remap-0')).toContainText('safe automatic remap', {
    timeout: LONG,
  })
  await page.getByTestId('mapping-continue').click()

  // Preflight / plan.
  await expect(page.getByTestId('screen-restore-preflight')).toBeVisible()
  await expect(page.getByTestId('plan-execute')).toBeVisible({ timeout: LONG })
  await expect(page.getByTestId('plan-summary')).toContainText(/step/)
  await expect(page.getByTestId('plan-blocked')).toHaveCount(0)
  await expect(page.getByTestId('plan-execute')).toBeEnabled()
  await page.getByTestId('plan-execute').click()

  // Progress → report.
  await expect(page.getByTestId('screen-restore-progress')).toBeVisible()
  await expect(page.getByTestId('restore-complete')).toBeVisible({ timeout: LONG })
  const projectPanel = page.locator('[data-testid^="report-project-"]').first()
  await expect(projectPanel).toContainText('demo')
  const projectId = (await projectPanel.getAttribute('data-testid'))!.replace('report-project-', '')
  await expect(page.getByTestId(`report-outcome-${projectId}-git`)).toHaveAttribute(
    'data-status',
    'ok',
  )
  await expect(page.getByTestId(`report-outcome-${projectId}-git`)).toContainText(/repository/i)
  await expect(page.getByTestId(`report-outcome-${projectId}-claude-code`)).toHaveAttribute(
    'data-status',
    'ok',
  )
  await expect(page.getByTestId(`report-outcome-${projectId}-claude-code`)).toContainText(
    /session/i,
  )
  await expect(page.getByTestId('report-attention')).toContainText('Claude Code authentication')
  const failedChecks = page.locator('[data-testid^="report-check-"][data-status="fail"]')
  await expect(failedChecks).toHaveCount(0)

  // Filesystem assertions on Mac B.
  const git = (args: string[], cwd: string) =>
    realExec('git', args, { cwd, env: { ...process.env, HOME: bobHome, GIT_CONFIG_NOSYSTEM: '1' } })
  const head = (await git(['rev-parse', 'HEAD'], newProjectPath)).stdout.trim()
  expect(head).toBe(source.fixture.repo.head)
  const branch = (await git(['symbolic-ref', '--short', 'HEAD'], newProjectPath)).stdout.trim()
  expect(branch).toBe(source.fixture.repo.primaryBranch)
  const worktreePath = path.join(bobHome, 'Developer', 'demo-onboarding')
  expect((await fs.stat(worktreePath)).isDirectory()).toBe(true)
  const worktrees = (await git(['worktree', 'list', '--porcelain'], newProjectPath)).stdout
  expect(worktrees).toContain(`worktree ${await fs.realpath(worktreePath)}`)
  const worktreeBranch = (
    await git(['symbolic-ref', '--short', 'HEAD'], worktreePath)
  ).stdout.trim()
  expect(worktreeBranch).toBe(source.fixture.repo.featureBranch)

  // Claude sessions were restored under the NEW project path with cwd rewritten and prose untouched.
  const sessionsDir = path.join(
    destination.fixture.home.claudeConfigDir,
    'projects',
    encodeClaudeProjectDir(newProjectPath),
  )
  expect((await fs.stat(sessionsDir)).isDirectory()).toBe(true)
  const transcripts = (await fs.readdir(sessionsDir)).filter((f) => f.endsWith('.jsonl'))
  expect(transcripts.length).toBeGreaterThanOrEqual(source.fixture.claude.projectSessionIds.length)
  const oldPath = source.fixture.projectPath
  const first = await readJsonl(path.join(sessionsDir, transcripts[0]!))
  const withCwd = first.records.filter((r) => typeof r.cwd === 'string')
  expect(withCwd.length).toBeGreaterThan(0)
  for (const record of withCwd) expect(record.cwd).toBe(newProjectPath)
  const assistant = first.records.find((r) => r.type === 'assistant') as
    { message?: { content?: { type: string; text?: string }[] } } | undefined
  const prose = assistant?.message?.content?.find((c) => c.type === 'text')?.text ?? ''
  expect(prose).toContain(oldPath)
  expect(prose).not.toContain(newProjectPath)
  expect(first.invalidLines.length).toBeGreaterThanOrEqual(1) // the deliberately broken line survives verbatim

  // Nothing was written outside the approved destinations: the source machine is untouched.
  const sourceHead = (
    await realExec('git', ['rev-parse', 'HEAD'], {
      cwd: source.fixture.projectPath,
      env: source.fixture.repo.env,
    })
  ).stdout.trim()
  expect(sourceHead).toBe(source.fixture.repo.head)

  await page.getByTestId('report-done').click()
  await expect(page.getByTestId('home')).toBeVisible()
})
