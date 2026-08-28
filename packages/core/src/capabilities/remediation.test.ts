import { Remediation } from '@devmig/model'
import { describe, expect, it } from 'vitest'
import { REMEDIATIONS, formatArgv, formatRemediation } from './remediation'

describe('REMEDIATIONS', () => {
  it('every entry validates against the model schema', () => {
    const all = [
      REMEDIATIONS.installClaudeCode(),
      REMEDIATIONS.ghLogin(),
      REMEDIATIONS.installGh(),
      REMEDIATIONS.installGit(),
      REMEDIATIONS.switchNode(22),
      REMEDIATIONS.installNode(22),
      REMEDIATIONS.installNode(null),
      REMEDIATIONS.installPackageManager('pnpm', '11.5.3'),
      REMEDIATIONS.installPackageManager('yarn', null),
      REMEDIATIONS.installPackageManager('bun', null),
      REMEDIATIONS.installPackageManager('npm', null),
      REMEDIATIONS.reinstallNativeDependencies('pnpm', '/p'),
    ]
    for (const r of all) expect(Remediation.parse(r)).toEqual(r)
  })

  it('never suggests a shell function or an invalid formula', () => {
    expect(REMEDIATIONS.switchNode(22).command?.[0]).not.toBe('nvm')
    expect(REMEDIATIONS.installPackageManager('npm', null).command).toEqual([
      'brew',
      'install',
      'node',
    ])
  })

  it('marks network/interactive actions and carries cwd for project commands', () => {
    expect(REMEDIATIONS.ghLogin()).toMatchObject({ network: true, interactive: true })
    expect(REMEDIATIONS.installClaudeCode()).toMatchObject({ network: true })
    expect(REMEDIATIONS.reinstallNativeDependencies('pnpm', '/p')).toMatchObject({
      cwd: '/p',
      command: ['pnpm', 'install'],
    })
    expect(REMEDIATIONS.reinstallNativeDependencies(null)).toMatchObject({
      command: ['npm', 'install'],
    })
  })

  it('formats argv with quoting only where needed', () => {
    expect(formatArgv(['gh', 'auth', 'login'])).toBe('gh auth login')
    expect(formatArgv(['echo', 'a b'])).toBe('echo "a b"')
    expect(
      formatRemediation({ id: 'x', title: 't', detail: 'd', command: ['gh'], url: 'https://x.y' }),
    ).toBe('d · Run: gh · See https://x.y')
  })
})
