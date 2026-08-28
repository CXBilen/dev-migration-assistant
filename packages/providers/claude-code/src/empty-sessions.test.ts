/**
 * Regression: a projects/<dir> with no transcripts (e.g. a leftover Claude worktree directory that
 * only holds <session>/tool-results) used to yield a "sessions (0)" artifact whose staging directory
 * was never created, so the backup engine rejected the section as invalid.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScannedArtifact } from '@devmig/model'
import {
  createClaudeFixture,
  createFakeHome,
  encodeClaudeProjectDir,
  makeTempRoot,
  type ClaudeFixture,
  type FakeHome,
  type TempRoot,
} from '@devmig/test-utils'
import { CLAUDE_CODE_PROVIDER_ID } from './constants'
import { ClaudeCodeProvider } from './provider'
import { backupContext, describeProject, scanContext } from './test-helpers'

let tmp: TempRoot
let home: FakeHome
let fixture: ClaudeFixture
let projectPath: string
let emptyDirName: string

const provider = new ClaudeCodeProvider({ isProcessAlive: () => false, platform: 'darwin' })

function metaOf(a: ScannedArtifact): { artifactKind?: unknown; dirName?: unknown } {
  return a.meta
}

beforeEach(async () => {
  tmp = await makeTempRoot('devmig-claude-empty-sessions-')
  home = await createFakeHome(tmp.root)
  projectPath = path.join(home.projectsDir, 'demo')
  fixture = await createClaudeFixture({
    claudeConfigDir: home.claudeConfigDir,
    claudeJsonPath: home.claudeJsonPath,
    projectPath,
    includeOrphanWorktreeSession: false,
    createProjectFiles: false,
  })
  // A Claude worktree directory with a session folder but no <session>.jsonl transcript.
  emptyDirName = encodeClaudeProjectDir(
    path.join(projectPath, '.claude', 'worktrees', 'stale-a1b2c3'),
  )
  const stale = path.join(
    home.claudeConfigDir,
    'projects',
    emptyDirName,
    '99807aaf-6b0a-4627-b28e-fe01f1f75965',
    'tool-results',
  )
  await fs.mkdir(stale, { recursive: true })
  await fs.writeFile(path.join(stale, 'bm6khobhm.txt'), 'leftover tool output\n')
})
afterEach(async () => {
  await tmp.cleanup()
})

describe('project directories without transcripts', () => {
  it('scan does not offer a sessions artifact for a directory with zero transcripts', async () => {
    const project = describeProject(projectPath)
    const result = await provider.scanProject(project, scanContext(home, [project]))
    const sessions = result.artifacts.filter((a) => metaOf(a).artifactKind === 'sessions')
    expect(sessions.map((a) => metaOf(a).dirName)).toEqual([fixture.encoded.project])
    expect(sessions.every((a) => (a.count ?? 0) > 0)).toBe(true)
  })

  it('backup always creates the sessions payload directory, even when every transcript is gone', async () => {
    const project = describeProject(projectPath)
    const scan = await provider.scanProject(project, scanContext(home, [project]))
    const real = scan.artifacts.find((a) => metaOf(a).artifactKind === 'sessions')
    expect(real).toBeDefined()
    // Simulate "no transcripts to copy" — the same shape the zero-transcript directory produced.
    const empty: ScannedArtifact = {
      ...real!,
      count: 0,
      meta: { ...real!.meta, sessionIds: [] },
    }
    const stagingRoot = path.join(tmp.root, 'staging')
    const ctx = backupContext(home, stagingRoot, { projectId: project.id })
    await fs.mkdir(ctx.providerDir, { recursive: true })
    const output = await provider.createBackupArtifacts(
      {
        project,
        artifacts: [empty],
        scan: {
          providerId: CLAUDE_CODE_PROVIDER_ID,
          projectId: project.id,
          detected: true,
          artifacts: scan.artifacts,
          summary: [],
          warnings: [],
          estimatedBytes: 0,
        },
      },
      ctx,
    )
    expect(output.artifacts).toHaveLength(1)
    const payload = path.join(stagingRoot, ...output.artifacts[0]!.payloadPath.split('/'))
    const st = await fs.lstat(payload)
    expect(st.isDirectory()).toBe(true)
    expect(output.artifacts[0]).toMatchObject({ fileCount: 0, sizeBytes: 0 })
  })
})
