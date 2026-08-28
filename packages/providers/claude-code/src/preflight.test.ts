/**
 * The `claude-running` preflight check. Its warn branch has no other coverage: every other test in
 * the suite injects `isProcessAlive: () => false` (merge.test.ts:33, provider.integration.test.ts:51,
 * empty-sessions.test.ts:29). THREAT_MODEL T14 / gate §5:124.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ManifestProviderSection } from '@devmig/model'
import { createFakeHome, makeTempRoot, type FakeHome, type TempRoot } from '@devmig/test-utils'
import { CLAUDE_CODE_PROVIDER_ID } from './constants'
import { ClaudeCodeProvider } from './provider'
import { planningContext } from './test-helpers'

const OLD = '/Users/alice/Documents/GitHub/demo'
const PROJECT_ID = 'p1'
const LIVE_SESSION = '11111111-1111-4111-8111-111111111111'
const DEAD_SESSION = '22222222-2222-4222-8222-222222222222'
const LIVE_PID = 4242
const DEAD_PID = 999_999

let tmp: TempRoot
let home: FakeHome
let payloadRoot: string
let newPath: string

const mapping = () => [{ projectId: PROJECT_ID, oldPath: OLD, newPath }]
const project = () => ({ id: PROJECT_ID, name: 'demo', oldPath: OLD, newPath })
const emptySection = (): ManifestProviderSection => ({
  providerId: CLAUDE_CODE_PROVIDER_ID,
  schemaVersion: 1,
  artifacts: [],
  summary: {},
})

/** `<claudeConfigDir>/sessions/` must exist or plan.ts:172 skips the probe entirely. */
async function writeSessionRegistry(): Promise<void> {
  const dir = path.join(home.claudeConfigDir, 'sessions')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${LIVE_SESSION}.json`),
    JSON.stringify({ pid: LIVE_PID, cwd: OLD, sessionId: LIVE_SESSION }),
  )
  await fs.writeFile(
    path.join(dir, `${DEAD_SESSION}.json`),
    JSON.stringify({ pid: DEAD_PID, cwd: OLD, sessionId: DEAD_SESSION }),
  )
  // A crashed session leaves half-written JSON behind; it must be skipped, not thrown on.
  await fs.writeFile(path.join(dir, 'broken.json'), '{ "pid": 12')
}

function providerWithProbe(isProcessAlive: (pid: number) => boolean): ClaudeCodeProvider {
  return new ClaudeCodeProvider({
    isProcessAlive,
    now: () => new Date('2026-08-28T10:00:00.000Z'),
    platform: 'linux',
  })
}

beforeEach(async () => {
  tmp = await makeTempRoot('devmig-claude-preflight-')
  home = await createFakeHome(tmp.root, { userName: 'bob' })
  payloadRoot = path.join(tmp.root, 'payload')
  await fs.mkdir(payloadRoot, { recursive: true })
  newPath = path.join(home.homeDir, 'Developer', 'demo')
  await fs.mkdir(newPath, { recursive: true })
  await writeSessionRegistry()
})
afterEach(async () => {
  await tmp.cleanup()
})

describe('claude-running preflight', () => {
  it('warns without blocking and names only the live pid when Claude Code is running', async () => {
    const provider = providerWithProbe((pid) => pid === LIVE_PID)
    const plan = await provider.planRestore(
      { project: project(), section: emptySection(), artifacts: [] },
      planningContext(home, payloadRoot, mapping()),
    )
    const check = plan.preflight.find((p) => p.id === 'claude-running')
    expect(check).toMatchObject({
      id: 'claude-running',
      label: 'Claude Code not running',
      status: 'warn',
      blocking: false,
    })
    expect(check?.detail).toContain('1 Claude Code process is running')
    expect(check?.detail).toContain(String(LIVE_PID))
    expect(check?.detail).not.toContain(String(DEAD_PID))
    // The malformed registry file is skipped, and nothing in the plan is blocking.
    expect(plan.preflight.filter((p) => p.status === 'fail')).toEqual([])
    expect(plan.preflight.filter((p) => p.blocking)).toEqual([])
  })

  it('passes when every recorded pid is dead and never throws CLAUDE_RUNNING', async () => {
    const provider = providerWithProbe(() => false)
    const plan = await provider.planRestore(
      { project: project(), section: emptySection(), artifacts: [] },
      planningContext(home, payloadRoot, mapping()),
    )
    const check = plan.preflight.find((p) => p.id === 'claude-running')
    expect(check).toMatchObject({ status: 'pass', blocking: false })
    expect(check?.detail).toBeUndefined()
    // Gate decision for 1.0.0: the reserved CLAUDE_RUNNING error code is never raised here.
    expect(JSON.stringify(plan)).not.toContain('CLAUDE_RUNNING')
  })
})
