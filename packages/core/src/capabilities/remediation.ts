/**
 * Remediation catalogue: structured "what to do about it" entries attached to attention items and,
 * from v0.2, to bootstrap actions. `command` is an argv array so the bootstrap engine can run it
 * without a shell after explicit consent (never silently).
 */
import type { Remediation } from '@devmig/model'
export type { Remediation }

/** Renders a remediation into a single human-readable line for AttentionItem.detail. */
export function formatRemediation(remediation: Remediation): string {
  const parts: string[] = []
  if (remediation.detail) parts.push(remediation.detail)
  if (remediation.command) parts.push(`Run: ${formatArgv(remediation.command)}`)
  if (remediation.url) parts.push(`See ${remediation.url}`)
  return parts.join(' · ')
}

/** Quotes argv elements that contain whitespace so the displayed line is unambiguous. */
export function formatArgv(argv: readonly string[]): string {
  return argv.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')
}

export const REMEDIATIONS = {
  installClaudeCode: (): Remediation => ({
    id: 'install-claude-code',
    title: 'Install Claude Code',
    detail: 'Claude Code is not installed on this Mac; restored sessions need it.',
    command: ['brew', 'install', '--cask', 'claude-code'],
    url: 'https://code.claude.com/docs/en/setup',
    network: true,
  }),
  ghLogin: (): Remediation => ({
    id: 'gh-auth-login',
    title: 'Sign in to the GitHub CLI',
    detail: 'Credentials are never migrated; authenticate again on this Mac.',
    command: ['gh', 'auth', 'login'],
    url: 'https://cli.github.com/manual/gh_auth_login',
    network: true,
    interactive: true,
  }),
  installGh: (): Remediation => ({
    id: 'install-gh',
    title: 'Install the GitHub CLI',
    command: ['brew', 'install', 'gh'],
    url: 'https://cli.github.com/',
    network: true,
  }),
  installGit: (): Remediation => ({
    id: 'install-git',
    title: 'Install Git',
    detail: 'Git is required to restore repositories and worktrees.',
    command: ['xcode-select', '--install'],
    url: 'https://git-scm.com/downloads/mac',
    network: true,
    interactive: true,
  }),
  switchNode: (major: number): Remediation => ({
    id: `node-major-${major}`,
    title: `Use Node.js ${major}`,
    detail: `The source machine used Node.js ${major}; pick the same major to avoid dependency surprises. Version-manager users (nvm, fnm, volta, mise): install it there instead.`,
    command: ['brew', 'install', `node@${major}`],
    url: 'https://nodejs.org/en/download',
    network: true,
  }),
  installNode: (major: number | null): Remediation => ({
    id: 'install-node',
    title: major !== null ? `Install Node.js ${major}` : 'Install Node.js',
    command: major !== null ? ['brew', 'install', `node@${major}`] : ['brew', 'install', 'node'],
    url: 'https://nodejs.org/en/download',
    network: true,
  }),
  installPackageManager: (id: string, version: string | null): Remediation => {
    switch (id) {
      case 'pnpm':
        return {
          id: 'install-pnpm',
          title: version ? `Install pnpm ${version}` : 'Install pnpm',
          command: version
            ? ['corepack', 'prepare', `pnpm@${version}`, '--activate']
            : ['corepack', 'enable', 'pnpm'],
          url: 'https://pnpm.io/installation',
          network: true,
        }
      case 'yarn':
        return {
          id: 'install-yarn',
          title: version ? `Install Yarn ${version}` : 'Install Yarn',
          command: version
            ? ['corepack', 'prepare', `yarn@${version}`, '--activate']
            : ['corepack', 'enable', 'yarn'],
          url: 'https://yarnpkg.com/getting-started/install',
          network: true,
        }
      case 'bun':
        return {
          id: 'install-bun',
          title: version ? `Install Bun ${version}` : 'Install Bun',
          command: ['brew', 'install', 'oven-sh/bun/bun'],
          url: 'https://bun.sh/docs/installation',
          network: true,
        }
      case 'npm':
        return {
          id: 'install-npm',
          title: 'Install npm (ships with Node.js)',
          command: ['brew', 'install', 'node'],
          url: 'https://nodejs.org/en/download',
          network: true,
        }
      default:
        return {
          id: `install-${id}`,
          title: `Install ${id}`,
          command: ['brew', 'install', id],
          network: true,
        }
    }
  },
  reinstallNativeDependencies: (packageManager: string | null, cwd?: string): Remediation => ({
    id: 'reinstall-native-deps',
    title: 'Reinstall dependencies',
    detail:
      'The CPU architecture differs from the source machine; native modules must be rebuilt for this Mac.',
    command: packageManager ? [packageManager, 'install'] : ['npm', 'install'],
    ...(cwd ? { cwd } : {}),
    network: true,
  }),
} as const
