/**
 * Regression (audit F5): an MCP server with `API_KEY=…` inline in `args` used to ship as a 'safe'
 * artifact. Such definitions now make the ~/.claude.json artifact sensitive and opt-in.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createClaudeFixture,
  createFakeHome,
  makeTempRoot,
  type FakeHome,
  type TempRoot,
} from '@devmig/test-utils'
import { ClaudeCodeProvider } from './provider'
import { describeProject, scanContext } from './test-helpers'

let tmp: TempRoot
let home: FakeHome
let projectPath: string
const provider = new ClaudeCodeProvider({ isProcessAlive: () => false, platform: 'darwin' })
const SECRET = '21st_sk_abcdefghijklmnopqrstuvwxyz'

beforeEach(async () => {
  tmp = await makeTempRoot('devmig-claude-mcp-secrets-')
  home = await createFakeHome(tmp.root)
  projectPath = path.join(home.projectsDir, 'demo')
  await createClaudeFixture({
    claudeConfigDir: home.claudeConfigDir,
    claudeJsonPath: home.claudeJsonPath,
    projectPath,
    includeOrphanWorktreeSession: false,
    createProjectFiles: false,
  })
  const json = JSON.parse(await fs.readFile(home.claudeJsonPath, 'utf8')) as {
    projects: Record<string, { mcpServers?: Record<string, unknown> }>
    mcpServers?: Record<string, unknown>
  }
  json.projects[projectPath]!.mcpServers = {
    ...json.projects[projectPath]!.mcpServers,
    magic: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@21st-dev/magic@latest', `API_KEY=${SECRET}`],
    },
  }
  json.mcpServers = {
    creds: { type: 'http', url: 'https://alice:hunter2pass@mcp.example.com/mcp' },
  }
  await fs.writeFile(home.claudeJsonPath, JSON.stringify(json, null, 2))
})
afterEach(async () => {
  await tmp.cleanup()
})

describe('inline MCP secrets', () => {
  it('make the project entries artifact sensitive and opt-in, naming the path but never the value', async () => {
    const project = describeProject(projectPath)
    const result = await provider.scanProject(project, scanContext(home, [project]))
    const entries = result.artifacts.find(
      (a) => (a.meta as { artifactKind?: string }).artifactKind === 'claude-json-project',
    )
    expect(entries).toMatchObject({ sensitivity: 'sensitive', includedByDefault: false })
    expect(entries?.reasons.join('\n')).toContain('magic: args[2]')
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('make the user-scope artifact sensitive and opt-in', async () => {
    const result = await provider.scanGlobal(scanContext(home, []))
    const user = result.artifacts.find(
      (a) => (a.meta as { artifactKind?: string }).artifactKind === 'global-claude-json-user',
    )
    expect(user).toMatchObject({ sensitivity: 'sensitive', includedByDefault: false })
    expect(JSON.stringify(result)).not.toContain('hunter2pass')
  })
})
