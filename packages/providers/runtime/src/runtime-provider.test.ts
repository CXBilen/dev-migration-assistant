import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { MachineInfo, ToolVersion } from '@devmig/model'
import { MigrationError, noopLogger } from '@devmig/shared'
import {
  createFakeExec,
  makeTempRoot,
  matchCommand,
  type FakeExec,
  type FakeExecHandler,
  type TempRoot,
} from '@devmig/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareMachines, compareProjectRuntime } from './compare'
import {
  detectProjectRuntime,
  parsePackageManagerField,
  summarizeProjectRuntime,
} from './project-runtime'
import { REMEDIATIONS, Remediation, formatArgv, formatRemediation } from './remediation'
import {
  MACHINE_ARTIFACT_ID,
  RUNTIME_PROVIDER_ID,
  RuntimeProvider,
  createRuntimeProvider,
  probeGhAuth,
  projectArtifactId,
  summarizeMachine,
} from './runtime-provider'
import { ProjectRuntimeInfo, RestoreState, RuntimeMachinePayload } from './schema'
import {
  backupContext,
  plainProject,
  planningContext,
  restoreContext,
  scanContext,
  verifyContext,
} from './test-context'
import { displayVersion, majorFromSpec, majorOf } from './versions'

let tmp: TempRoot
beforeEach(async () => {
  tmp = await makeTempRoot('devmig-runtime-')
})
afterEach(async () => {
  await tmp.cleanup()
})

interface ToolSpec {
  node?: string
  pnpm?: string
  npm?: string
  bun?: string
  git?: string
  claude?: string
  gh?: string
  brew?: string
  ghAuthExit?: number
}

/** Builds a FakeExec answering the probes collectMachineInfo issues; missing tools throw PATH_NOT_FOUND. */
function machineExec(spec: ToolSpec): FakeExec {
  const handlers: FakeExecHandler[] = [
    { match: matchCommand('sw_vers', '-productVersion'), result: { stdout: '26.6\n' } },
  ]
  const add = (file: string, stdout: string | undefined): void => {
    if (stdout !== undefined)
      handlers.push({ match: matchCommand(file, '--version'), result: { stdout } })
  }
  add('node', spec.node && `v${spec.node}\n`)
  add('pnpm', spec.pnpm && `${spec.pnpm}\n`)
  add('npm', spec.npm && `${spec.npm}\n`)
  add('bun', spec.bun && `${spec.bun}\n`)
  add('git', spec.git && `git version ${spec.git}\n`)
  add('claude', spec.claude && `${spec.claude} (Claude Code)\n`)
  add(
    'gh',
    spec.gh &&
      `gh version ${spec.gh} (2026-01-01)\nhttps://github.com/cli/cli/releases/tag/v${spec.gh}\n`,
  )
  add('brew', spec.brew && `Homebrew ${spec.brew}\n`)
  if (spec.gh !== undefined) {
    handlers.push({
      match: matchCommand('gh', 'auth', 'status'),
      result: {
        exitCode: spec.ghAuthExit ?? 0,
        stderr: spec.ghAuthExit ? 'You are not logged into any GitHub hosts.' : '',
      },
    })
  }
  return createFakeExec(handlers)
}

const SOURCE_TOOLS: ToolSpec = {
  node: '22.22.3',
  pnpm: '11.5.3',
  npm: '11.0.0',
  git: '2.50.1',
  claude: '2.1.247',
  gh: '2.63.0',
  brew: '4.4.0',
}

function toolsOf(spec: ToolSpec): ToolVersion[] {
  const entries: [string, string, string | undefined][] = [
    ['node', 'Node.js', spec.node && `v${spec.node}`],
    ['pnpm', 'pnpm', spec.pnpm],
    ['npm', 'npm', spec.npm],
    ['bun', 'Bun', spec.bun],
    ['git', 'Git', spec.git && `git version ${spec.git}`],
    ['claude', 'Claude Code', spec.claude],
    ['gh', 'GitHub CLI', spec.gh && `gh version ${spec.gh}`],
    ['brew', 'Homebrew', spec.brew && `Homebrew ${spec.brew}`],
  ]
  return entries.map(([id, label, version]) => ({
    id,
    label,
    version: version ?? null,
    path: null,
    installed: version !== undefined,
  }))
}

function machineOf(spec: ToolSpec, overrides: Partial<MachineInfo> = {}): MachineInfo {
  return {
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '26.6',
    machineLabel: null,
    homeDir: '/Users/alice',
    userName: 'alice',
    tools: toolsOf(spec),
    capturedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  }
}

describe('version helpers', () => {
  it('extracts display versions and majors from tool output', () => {
    expect(displayVersion('v22.22.3')).toBe('22.22.3')
    expect(displayVersion('git version 2.50.1')).toBe('2.50.1')
    expect(displayVersion('gh version 2.63.0 (2026-01-01)')).toBe('2.63.0')
    expect(displayVersion('2.1.247')).toBe('2.1.247')
    expect(displayVersion(null)).toBeNull()
    expect(majorOf('v22.22.3')).toBe(22)
    expect(majorOf(null)).toBeNull()
    expect(majorFromSpec('^15.1.0')).toBe(15)
    expect(majorFromSpec('>=22.12.0')).toBe(22)
    expect(majorFromSpec('workspace:*')).toBeNull()
    expect(majorFromSpec('latest')).toBeNull()
  })

  it('parses the packageManager field', () => {
    expect(parsePackageManagerField('pnpm@11.5.3')).toEqual({
      id: 'pnpm',
      version: '11.5.3',
      source: 'packageManager',
      lockfile: null,
    })
    expect(parsePackageManagerField('yarn@4.5.0+sha512.abc')).toMatchObject({
      id: 'yarn',
      version: '4.5.0',
    })
    expect(parsePackageManagerField('cargo@1')).toBeNull()
    expect(parsePackageManagerField('pnpm@-1')).toBeNull()
  })
})

describe('remediation', () => {
  it('formats argv for display and validates the schema', () => {
    const r = REMEDIATIONS.installPackageManager('pnpm', '11.5.3')
    expect(Remediation.parse(r)).toEqual(r)
    expect(r.command).toEqual(['corepack', 'prepare', 'pnpm@11.5.3', '--activate'])
    expect(formatArgv(['gh', 'auth', 'login', '--hostname', 'git hub'])).toBe(
      'gh auth login --hostname "git hub"',
    )
    expect(formatRemediation(REMEDIATIONS.ghLogin())).toContain('Run: gh auth login')
    expect(formatRemediation(REMEDIATIONS.installClaudeCode())).toContain('https://code.claude.com')
  })
})

describe('project runtime detection', () => {
  it('reads package manager, workspace, node pin and frameworks from a project root', async () => {
    const root = path.join(tmp.root, 'app')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'app',
        packageManager: 'pnpm@11.5.3',
        engines: { node: '>=22.12.0' },
        dependencies: { next: '^15.1.0', react: '^19.0.0' },
        devDependencies: { vite: '^7.0.0' },
      }),
    )
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    await fs.writeFile(path.join(root, '.nvmrc'), 'v22\n')

    const { runtime, warnings } = await detectProjectRuntime(root)
    expect(warnings).toEqual([])
    expect(ProjectRuntimeInfo.parse(runtime)).toEqual(runtime)
    expect(runtime.packageManager).toEqual({
      id: 'pnpm',
      version: '11.5.3',
      source: 'packageManager',
      lockfile: 'pnpm-lock.yaml',
    })
    expect(runtime.workspace).toBe('pnpm-workspace.yaml')
    expect(runtime.nodePin).toEqual({ source: '.nvmrc', raw: '22', major: 22 })
    expect(runtime.engines).toEqual({ node: '>=22.12.0' })
    expect(runtime.frameworks.map((f) => `${f.label} ${f.major}`)).toEqual([
      'Next.js 15',
      'Vite 7',
      'React 19',
    ])
    expect(summarizeProjectRuntime(runtime)).toEqual([
      { label: 'pnpm workspace', status: 'ok', detail: 'pnpm-workspace.yaml' },
      { label: 'pnpm 11.5.3', status: 'ok', detail: 'package.json packageManager' },
      { label: 'Node 22 (.nvmrc)', status: 'ok' },
      { label: 'engines.node >=22.12.0', status: 'info' },
      { label: 'Next.js 15.x', status: 'ok' },
      { label: 'Vite 7.x', status: 'ok' },
      { label: 'React 19.x', status: 'ok' },
    ])
  })

  it('falls back to lockfiles, tolerates broken package.json and reports empty projects', async () => {
    const root = path.join(tmp.root, 'legacy')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'package.json'), '{ not json')
    await fs.writeFile(path.join(root, 'yarn.lock'), '')
    await fs.writeFile(path.join(root, 'package-lock.json'), '{}')
    await fs.writeFile(path.join(root, '.node-version'), 'lts/iron\n')
    const { runtime, warnings } = await detectProjectRuntime(root)
    expect(warnings).toEqual([
      'package.json is not valid JSON; runtime hints may be incomplete.',
      'Several lockfiles found (yarn.lock, package-lock.json); yarn was assumed.',
    ])
    expect(runtime.packageManager).toEqual({
      id: 'yarn',
      version: null,
      source: 'lockfile',
      lockfile: 'yarn.lock',
    })
    expect(runtime.nodePin).toEqual({ source: '.node-version', raw: 'lts/iron', major: null })

    const empty = path.join(tmp.root, 'empty')
    await fs.mkdir(empty)
    const none = await detectProjectRuntime(empty)
    expect(none.runtime.hasPackageJson).toBe(false)
    expect(none.runtime.packageManager).toBeNull()
  })
})

describe('compareMachines', () => {
  it('reports compatible tools on an identical destination', () => {
    const out = compareMachines(machineOf(SOURCE_TOOLS), machineOf(SOURCE_TOOLS), 'ok')
    expect(out.items.map((i) => [i.label, i.status])).toEqual([
      ['macOS 26.6 arm64 → macOS 26.6 arm64', 'info'],
      ['Git installed', 'ok'],
      ['Node compatible (22 → 22)', 'ok'],
      ['pnpm installed', 'ok'],
      ['npm installed', 'ok'],
      ['Claude Code installed', 'ok'],
      ['GitHub CLI authenticated', 'ok'],
    ])
    expect(out.attention).toEqual([])
  })

  it('flags missing Claude Code, gh login, Node major and package manager with remediations', () => {
    const destination = machineOf(
      { node: '20.19.0', npm: '10.0.0', git: '2.39.0', gh: '2.63.0' },
      { arch: 'x64' },
    )
    const out = compareMachines(machineOf(SOURCE_TOOLS), destination, 'unauthenticated')
    const labels = out.items.map((i) => i.label)
    expect(labels).toContain('CPU architecture differs (arm64 → x64)')
    expect(labels).toContain('Node major differs (22 → 20)')
    expect(labels).toContain('pnpm not installed')
    expect(labels).toContain('Claude Code not installed')
    expect(labels).toContain('GitHub CLI authentication required')
    expect(labels).toContain('Homebrew not installed')
    expect(out.attention.map((a) => [a.id, a.action, a.level])).toEqual([
      ['runtime:arch', 'manual', 'warn'],
      ['runtime:node-major', 'manual', 'warn'],
      ['runtime:pm-missing-pnpm', 'install', 'warn'],
      ['runtime:claude-code-missing', 'install', 'warn'],
      ['runtime:gh-auth', 'reauth', 'warn'],
    ])
    expect(out.remediations.map((r) => r.id)).toEqual([
      'reinstall-native-deps',
      'node-major-22',
      'install-pnpm',
      'install-claude-code',
      'gh-auth-login',
    ])
    const claude = out.attention.find((a) => a.id === 'runtime:claude-code-missing')
    expect(claude?.detail).toContain('Run: brew install --cask claude-code')
  })

  it('treats a missing gh as an info-level install hint and missing git as an error', () => {
    const out = compareMachines(
      machineOf(SOURCE_TOOLS),
      machineOf({ node: '22.0.0' }),
      'not-installed',
    )
    expect(out.items.find((i) => i.label === 'Git not installed')?.status).toBe('error')
    expect(out.attention.find((a) => a.id === 'runtime:gh-missing')).toMatchObject({
      level: 'info',
      action: 'install',
    })
    expect(out.attention.find((a) => a.id === 'runtime:git-missing')).toMatchObject({
      action: 'install',
    })
  })
})

describe('compareProjectRuntime', () => {
  const runtime: ProjectRuntimeInfo = {
    hasPackageJson: true,
    packageName: 'app',
    packageManager: {
      id: 'pnpm',
      version: '11.5.3',
      source: 'packageManager',
      lockfile: 'pnpm-lock.yaml',
    },
    lockfiles: ['pnpm-lock.yaml'],
    workspace: 'pnpm-workspace.yaml',
    engines: { node: '>=22.12.0' },
    nodePin: { source: '.nvmrc', raw: '22', major: 22 },
    frameworks: [{ id: 'next', label: 'Next.js', spec: '^15.1.0', major: 15 }],
  }

  it('is satisfied when the package manager and Node major are present', () => {
    const out = compareProjectRuntime('p1', runtime, machineOf(SOURCE_TOOLS))
    expect(out.items.map((i) => [i.label, i.status])).toEqual([
      ['pnpm installed', 'ok'],
      ['Node compatible (22 → 22)', 'ok'],
      ['Next.js 15.x', 'info'],
    ])
    expect(out.attention).toEqual([])
  })

  it('asks for the package manager and the pinned Node major when they are missing', () => {
    const out = compareProjectRuntime(
      'p1',
      runtime,
      machineOf({ node: '20.0.0', npm: '10.0.0', git: '2.5.0' }),
    )
    expect(out.items.map((i) => i.label)).toEqual([
      'pnpm not installed',
      'Node major differs (22 → 20)',
      'Next.js 15.x',
    ])
    expect(out.attention.map((a) => a.id)).toEqual([
      'runtime:p1:pm-missing-pnpm',
      'runtime:p1:node-major',
    ])
    expect(out.remediations[0]?.command).toEqual([
      'corepack',
      'prepare',
      'pnpm@11.5.3',
      '--activate',
    ])
  })

  it('uses engines.node as a minimum when there is no pin', () => {
    const noPin = { ...runtime, nodePin: null }
    const ok = compareProjectRuntime('p1', noPin, machineOf({ node: '24.1.0', pnpm: '11.5.3' }))
    expect(ok.items[1]).toMatchObject({
      label: 'Node compatible (22 → 24)',
      status: 'ok',
      detail: 'engines.node',
    })
    const old = compareProjectRuntime('p1', noPin, machineOf({ node: '18.0.0', pnpm: '11.5.3' }))
    expect(old.items[1]).toMatchObject({ label: 'Node major differs (22 → 18)', status: 'warn' })
  })
})

describe('RuntimeProvider', () => {
  const provider = new RuntimeProvider()

  it('exposes the expected identity', () => {
    const created = createRuntimeProvider()
    expect(created.id).toBe(RUNTIME_PROVIDER_ID)
    expect(created.displayName).toBe('Development runtime')
    expect(created.supportsGlobal).toBe(true)
    expect(created.schemaVersion).toBe(1)
  })

  it('scanGlobal produces the machine artifact and one summary row per tool', async () => {
    const exec = machineExec(SOURCE_TOOLS)
    const result = await provider.scanGlobal(scanContext({ homeDir: tmp.root, exec: exec.exec }))
    expect(result.detected).toBe(true)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toMatchObject({
      id: MACHINE_ARTIFACT_ID,
      kind: 'json-fragment',
      scope: 'user',
      sensitivity: 'safe',
      includedByDefault: true,
      selectable: true,
    })
    expect(result.summary).toEqual(
      expect.arrayContaining([
        { label: 'Node 22.22.3', status: 'ok' },
        { label: 'pnpm 11.5.3', status: 'ok' },
        { label: 'Git 2.50.1', status: 'ok' },
        { label: 'Claude Code 2.1.247', status: 'ok' },
        { label: 'Bun not installed', status: 'info' },
        { label: 'macOS 26.6 · arm64', status: 'info' },
      ]),
    )
    expect(exec.calls.every((c) => c.options?.reject === false)).toBe(true)
    expect(exec.calls.some((c) => c.file === 'gh' && c.args[0] === 'auth')).toBe(false)
  })

  it('scanProject reports runtime hints for a pnpm/Next.js project and nothing for an empty dir', async () => {
    const root = path.join(tmp.root, 'demo')
    await fs.mkdir(root)
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { next: '15.2.0' } }),
    )
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), '')
    await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    const exec = machineExec({})
    const project = plainProject(root)
    const result = await provider.scanProject(
      project,
      scanContext({ homeDir: tmp.root, exec: exec.exec }),
    )
    expect(exec.calls).toHaveLength(0)
    expect(result.detected).toBe(true)
    expect(result.artifacts[0]).toMatchObject({
      id: projectArtifactId(project.id),
      kind: 'json-fragment',
      sensitivity: 'safe',
      includedByDefault: true,
      description: 'pnpm · Next.js 15.x',
    })
    expect(result.summary).toEqual([
      { label: 'pnpm workspace', status: 'ok', detail: 'pnpm-workspace.yaml' },
      { label: 'pnpm', status: 'ok', detail: 'pnpm-lock.yaml' },
      { label: 'Next.js 15.x', status: 'ok' },
    ])

    const empty = path.join(tmp.root, 'empty')
    await fs.mkdir(empty)
    const none = await provider.scanProject(
      plainProject(empty),
      scanContext({ homeDir: tmp.root, exec: exec.exec }),
    )
    expect(none.detected).toBe(false)
    expect(none.artifacts).toEqual([])
    expect(none.summary[0]?.label).toBe('No runtime hints found')
  })

  it('summarizeMachine handles unknown tool ids gracefully', () => {
    const rows = summarizeMachine(
      machineOf({}, { tools: [{ id: 'deno', label: 'Deno', version: '2.1.0', installed: true }] }),
    )
    expect(rows[0]).toEqual({ label: 'Deno 2.1.0', status: 'ok' })
  })

  describe('backup → plan → restore → verify', () => {
    async function backupGlobal(sourceSpec: ToolSpec) {
      const exec = machineExec(sourceSpec)
      const scan = await provider.scanGlobal(scanContext({ homeDir: tmp.root, exec: exec.exec }))
      const payloadRoot = path.join(tmp.root, 'payload')
      const relDir = 'global/runtime'
      const stagingDir = path.join(payloadRoot, 'global', 'runtime')
      await fs.mkdir(stagingDir, { recursive: true })
      const output = await provider.createBackupArtifacts(
        { artifacts: scan.artifacts, scan },
        backupContext({ homeDir: tmp.root, exec: exec.exec, stagingDir, relDir }),
      )
      return {
        scan,
        output,
        payloadRoot,
        section: {
          providerId: RUNTIME_PROVIDER_ID,
          schemaVersion: 1,
          artifacts: output.artifacts,
          summary: output.summary ?? {},
        },
      }
    }

    it('writes runtime.json and compares it with the destination without writing anything', async () => {
      const { output, payloadRoot, section } = await backupGlobal(SOURCE_TOOLS)
      expect(output.artifacts[0]?.payloadPath).toBe('global/runtime/runtime.json')
      const payload = RuntimeMachinePayload.parse(
        JSON.parse(
          await fs.readFile(path.join(payloadRoot, 'global', 'runtime', 'runtime.json'), 'utf8'),
        ),
      )
      expect(payload.machine.tools.find((t) => t.id === 'node')?.version).toBe('v22.22.3')
      expect(output.summary).toMatchObject({ tools: { node: '22.22.3', bun: null } })

      // Destination: Node 20, no Claude Code, gh installed but logged out.
      const destExec = machineExec({
        node: '20.19.0',
        pnpm: '11.5.3',
        npm: '10.0.0',
        git: '2.50.1',
        gh: '2.63.0',
        brew: '4.4.0',
        ghAuthExit: 1,
      })
      const destHome = path.join(tmp.root, 'dest-home')
      await fs.mkdir(destHome)
      const input = { section, artifacts: output.artifacts }
      const plan = await provider.planRestore(
        input,
        planningContext({ homeDir: destHome, exec: destExec.exec, payloadRoot }),
      )
      expect(plan.collisions).toEqual([])
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0]?.destination).toBeUndefined()
      expect(plan.preflight.every((p) => !p.blocking)).toBe(true)
      expect(plan.preflight.map((p) => p.label)).toContain('Claude Code not installed')

      const claudeDir = path.join(destHome, '.claude')
      const result = await provider.restore(
        plan,
        input,
        restoreContext({
          homeDir: destHome,
          exec: destExec.exec,
          payloadRoot,
          roots: [claudeDir, path.join(destHome, '.claude.json')],
        }),
      )
      expect(result.status).toBe('ok')
      expect(result.items.map((i) => [i.label, i.status])).toEqual(
        expect.arrayContaining([
          ['Git installed', 'ok'],
          ['Node major differs (22 → 20)', 'warn'],
          ['pnpm installed', 'ok'],
          ['Claude Code not installed', 'warn'],
          ['GitHub CLI authentication required', 'warn'],
        ]),
      )
      expect(result.attention?.map((a) => [a.id, a.action])).toEqual([
        ['runtime:node-major', 'manual'],
        ['runtime:claude-code-missing', 'install'],
        ['runtime:gh-auth', 'reauth'],
      ])
      const state = RestoreState.parse(result.state)
      expect(state.remediations.map((r) => r.id)).toEqual([
        'node-major-22',
        'install-claude-code',
        'gh-auth-login',
      ])
      // Probed once for the plan's preflight and once for the report.
      expect(destExec.callsMatching(matchCommand('gh', 'auth', 'status'))).toHaveLength(2)
      // Nothing was written anywhere in the destination home.
      expect(await fs.readdir(destHome)).toEqual([])

      const verification = await provider.verify(
        { plan, result, input },
        verifyContext({ homeDir: destHome, exec: destExec.exec, payloadRoot }),
      )
      expect(verification.checks[0]).toMatchObject({ id: 'payload:machine', status: 'pass' })
      expect(verification.checks.find((c) => c.label === 'Claude Code not installed')?.status).toBe(
        'warn',
      )
      expect(verification.checks.find((c) => c.label === 'Git installed')?.status).toBe('pass')
    })

    it('reports a clean bill on an identical destination and gh-missing as info', async () => {
      const { output, payloadRoot, section } = await backupGlobal({
        node: '22.22.3',
        git: '2.50.1',
        claude: '2.1.247',
      })
      const destExec = machineExec({ node: '22.22.3', git: '2.50.1', claude: '2.1.247' })
      const input = { section, artifacts: output.artifacts }
      const plan = await provider.planRestore(
        input,
        planningContext({ homeDir: tmp.root, exec: destExec.exec, payloadRoot }),
      )
      const result = await provider.restore(
        plan,
        input,
        restoreContext({ homeDir: tmp.root, exec: destExec.exec, payloadRoot, roots: [tmp.root] }),
      )
      expect(result.items.filter((i) => i.status === 'warn' || i.status === 'error')).toEqual([])
      expect(result.attention).toEqual([
        expect.objectContaining({ id: 'runtime:gh-missing', level: 'info', action: 'install' }),
      ])
    })

    it('project unit: writes project-runtime.json and asks to install the missing package manager', async () => {
      const root = path.join(tmp.root, 'proj')
      await fs.mkdir(root)
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'proj', packageManager: 'pnpm@11.5.3' }),
      )
      await fs.writeFile(path.join(root, '.nvmrc'), '22\n')
      const project = plainProject(root)
      const srcExec = machineExec(SOURCE_TOOLS)
      const scan = await provider.scanProject(
        project,
        scanContext({ homeDir: tmp.root, exec: srcExec.exec }),
      )
      const payloadRoot = path.join(tmp.root, 'payload')
      const relDir = `projects/${project.id}/runtime`
      const stagingDir = path.join(payloadRoot, 'projects', project.id, 'runtime')
      await fs.mkdir(stagingDir, { recursive: true })
      const output = await provider.createBackupArtifacts(
        { project, artifacts: scan.artifacts, scan },
        backupContext({ homeDir: tmp.root, exec: srcExec.exec, stagingDir, relDir }),
      )
      expect(output.artifacts[0]?.payloadPath).toBe(`${relDir}/project-runtime.json`)
      expect(output.summary).toMatchObject({ packageManager: 'pnpm', nodePin: '22' })

      const destExec = machineExec({ node: '22.1.0', npm: '10.0.0', git: '2.50.1' })
      const newPath = path.join(tmp.root, 'restored', 'proj')
      const input = {
        project: { id: project.id, name: project.name, oldPath: root, newPath },
        section: {
          providerId: RUNTIME_PROVIDER_ID,
          schemaVersion: 1,
          artifacts: output.artifacts,
          summary: {},
        },
        artifacts: output.artifacts,
      }
      const mappings = [{ projectId: project.id, oldPath: root, newPath }]
      const plan = await provider.planRestore(
        input,
        planningContext({ homeDir: tmp.root, exec: destExec.exec, payloadRoot, mappings }),
      )
      expect(plan.projectId).toBe(project.id)
      expect(plan.preflight.map((p) => [p.label, p.status, p.blocking])).toEqual([
        ['pnpm not installed', 'warn', false],
        ['Node compatible (22 → 22)', 'pass', false],
      ])
      const result = await provider.restore(
        plan,
        input,
        restoreContext({
          homeDir: tmp.root,
          exec: destExec.exec,
          payloadRoot,
          roots: [newPath],
          mappings,
        }),
      )
      expect(result.status).toBe('ok')
      expect(result.attention).toHaveLength(1)
      expect(result.attention?.[0]).toMatchObject({
        id: `runtime:${project.id}:pm-missing-pnpm`,
        action: 'install',
      })
      expect(result.attention?.[0]?.detail).toContain('corepack prepare pnpm@11.5.3 --activate')
      expect(await fs.stat(newPath).catch(() => null)).toBeNull()
      const verification = await provider.verify(
        { plan, result, input },
        verifyContext({ homeDir: tmp.root, exec: destExec.exec, payloadRoot }),
      )
      expect(verification.checks.map((c) => c.status)).toEqual(['pass', 'warn', 'pass'])
    })

    it('fails closed on a tampered runtime.json and on cancellation', async () => {
      const { output, payloadRoot, section } = await backupGlobal(SOURCE_TOOLS)
      const input = { section, artifacts: output.artifacts }
      const destExec = machineExec(SOURCE_TOOLS)
      await fs.writeFile(
        path.join(payloadRoot, 'global', 'runtime', 'runtime.json'),
        '{"schemaVersion":1}',
      )
      await expect(
        provider.planRestore(
          input,
          planningContext({ homeDir: tmp.root, exec: destExec.exec, payloadRoot }),
        ),
      ).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' })

      const controller = new AbortController()
      controller.abort()
      await expect(
        provider.createBackupArtifacts(
          {
            artifacts: output.artifacts.length
              ? [{ ...output.artifacts[0]!, meta: {} } as never]
              : [],
            scan: {
              providerId: RUNTIME_PROVIDER_ID,
              detected: true,
              artifacts: [],
              summary: [],
              warnings: [],
              estimatedBytes: 0,
            },
          },
          backupContext({
            homeDir: tmp.root,
            exec: destExec.exec,
            stagingDir: payloadRoot,
            relDir: 'global/runtime',
            signal: controller.signal,
          }),
        ),
      ).rejects.toMatchObject({ code: 'CANCELLED' })
    })

    it('refuses artifacts with invalid metadata at backup time', async () => {
      const exec = machineExec(SOURCE_TOOLS)
      const stagingDir = path.join(tmp.root, 'stage')
      await fs.mkdir(stagingDir)
      await expect(
        provider.createBackupArtifacts(
          {
            artifacts: [
              {
                id: MACHINE_ARTIFACT_ID,
                providerId: RUNTIME_PROVIDER_ID,
                scope: 'user',
                kind: 'json-fragment',
                label: 'x',
                sensitivity: 'safe',
                includedByDefault: true,
                selectable: true,
                reasons: [],
                meta: { machine: { nope: true } },
              },
            ],
            scan: {
              providerId: RUNTIME_PROVIDER_ID,
              detected: true,
              artifacts: [],
              summary: [],
              warnings: [],
              estimatedBytes: 0,
            },
          },
          backupContext({
            homeDir: tmp.root,
            exec: exec.exec,
            stagingDir,
            relDir: 'global/runtime',
          }),
        ),
      ).rejects.toBeInstanceOf(MigrationError)
    })
  })

  it('probeGhAuth maps exit codes and tolerates a missing binary', async () => {
    const env = {}
    const signal = new AbortController().signal
    const ok = createFakeExec([
      { match: matchCommand('gh', 'auth', 'status'), result: { exitCode: 0 } },
    ])
    expect(await probeGhAuth(ok.exec, env, signal, true)).toBe('ok')
    const loggedOut = createFakeExec([
      { match: matchCommand('gh', 'auth', 'status'), result: { exitCode: 1 } },
    ])
    expect(await probeGhAuth(loggedOut.exec, env, signal, true)).toBe('unauthenticated')
    const broken = createFakeExec([
      { match: matchCommand('gh', 'auth', 'status'), result: { exitCode: 4 } },
    ])
    expect(await probeGhAuth(broken.exec, env, signal, true)).toBe('unavailable')
    const missing = createFakeExec([])
    expect(await probeGhAuth(missing.exec, env, signal, true)).toBe('unavailable')
    expect(await probeGhAuth(missing.exec, env, signal, false)).toBe('not-installed')
    expect(missing.calls).toHaveLength(1)
  })

  it('detect lists every probed tool', async () => {
    const exec = machineExec(SOURCE_TOOLS)
    const detection = await provider.detect({
      homeDir: tmp.root,
      claudeConfigDir: path.join(tmp.root, '.claude'),
      claudeJsonPath: path.join(tmp.root, '.claude.json'),
      env: {},
      exec: exec.exec,
      logger: noopLogger,
    })
    expect(detection.available).toBe(true)
    expect(detection.details).toMatchObject({
      node: '22.22.3',
      bun: 'not installed',
      claude: '2.1.247',
    })
  })
})
