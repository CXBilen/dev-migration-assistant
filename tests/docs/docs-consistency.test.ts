/**
 * Documentation and CI consistency tests.
 *
 * These guard the parts of the open-source packaging that silently rot:
 *   - relative links in the docs point at files that exist,
 *   - workflows only call pnpm scripts that exist in package.json,
 *   - ci.yml uses no secrets, release.yml keeps signing conditional,
 *   - issue templates carry valid front matter,
 *   - README claims (node/pnpm versions, script names, provider ids) match the repo.
 *
 * Read-only: nothing here touches anything outside the repository checkout.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** Docs owned by the packaging/docs workstream. Every relative link inside them must resolve. */
const OWNED_DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'docs/USER_GUIDE.md',
  'docs/ROADMAP.md',
  'docs/KNOWN_LIMITATIONS.md',
  'docs/security/THREAT_MODEL.md',
  'docs/providers/AUTHORING.md',
  'docs/release/RELEASE.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
] as const

/**
 * Link targets that are referenced on purpose before their owning workstream lands them.
 * The integrator removes entries here as the files appear; an entry that exists on disk fails the test
 * so the list cannot silently outlive its purpose.
 */
const PENDING_LINK_TARGETS = new Set<string>(['docs/backup-format/DEVBACKUP_SPEC.md'])

interface PackageJson {
  version: string
  packageManager: string
  engines: { node: string }
  scripts: Record<string, string>
}

async function readText(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8')
}

async function readPackageJson(rel = 'package.json'): Promise<PackageJson> {
  return JSON.parse(await readText(rel)) as PackageJson
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.access(path.join(ROOT, rel))
    return true
  } catch {
    return false
  }
}

/** Extracts markdown link targets `[text](target)` excluding images, absolute URLs, mailto and pure anchors. */
function relativeLinkTargets(markdown: string): string[] {
  const out: string[] = []
  const re = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const match of markdown.matchAll(re)) {
    const isImage = match[1] === '!'
    const target = match[2] ?? ''
    if (isImage) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // http:, https:, mailto:
    if (target.startsWith('#')) continue
    out.push(target)
  }
  return out
}

/** GitHub-style heading slug: lower-case, strip punctuation, spaces → dashes. */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>()
  const counts = new Map<string, number>()
  for (const line of markdown.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const base = slugify(m[1] ?? '')
    const n = counts.get(base) ?? 0
    counts.set(base, n + 1)
    slugs.add(n === 0 ? base : `${base}-${n}`)
  }
  return slugs
}

/** Minimal YAML front-matter reader for issue templates (`---\nkey: value\n---`). */
function frontMatter(markdown: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(markdown)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1] ?? ''] = (kv[2] ?? '').trim()
  }
  return out
}

/** Concatenated contents of every `run:` step in a workflow (single-line and block scalars). */
function runBlocks(workflowYaml: string): string {
  const lines = workflowYaml.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line)
    if (!m) continue
    const keyIndent = (m[1] ?? '').length
    const rest = (m[2] ?? '').trim()
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? ''
        const indent = (/^\s*/.exec(next)?.[0] ?? '').length
        if (next.trim() !== '' && indent <= keyIndent) break
        out.push(next)
      }
    } else {
      out.push(rest)
    }
  }
  return out.join('\n')
}

/** `pnpm <script>` invocations inside `run:` steps of a workflow. Comments and step names are ignored. */
function pnpmScriptCalls(workflowYaml: string): string[] {
  const calls: string[] = []
  for (const m of runBlocks(workflowYaml).matchAll(/\bpnpm\s+([a-z][a-z0-9:-]*)/g)) {
    const script = m[1] ?? ''
    if (script === 'install' || script === 'exec' || script === 'dlx') continue
    calls.push(script)
  }
  return calls
}

describe('documentation links', () => {
  for (const doc of OWNED_DOCS) {
    it(`${doc}: every relative link resolves (or is an acknowledged pending target)`, async () => {
      const markdown = await readText(doc)
      const docDir = path.dirname(doc)
      const missing: string[] = []
      for (const target of relativeLinkTargets(markdown)) {
        const [file, anchor] = target.split('#') as [string, string | undefined]
        const resolved = path.normalize(path.join(docDir, file))
        if (PENDING_LINK_TARGETS.has(resolved)) continue
        if (!(await exists(resolved))) {
          missing.push(target)
          continue
        }
        if (anchor && resolved.endsWith('.md')) {
          const slugs = headingSlugs(await readText(resolved))
          if (!slugs.has(anchor)) missing.push(`${target} (anchor)`)
        }
      }
      expect(missing, `broken links in ${doc}`).toEqual([])
    })
  }

  it('pending link targets are still absent (remove them from the list once they land)', async () => {
    for (const rel of PENDING_LINK_TARGETS) {
      expect(await exists(rel), `${rel} exists now — drop it from PENDING_LINK_TARGETS`).toBe(false)
    }
  })

  it('README documentation index lists every doc this workstream owns', async () => {
    const readme = await readText('README.md')
    for (const doc of [
      'docs/USER_GUIDE.md',
      'docs/architecture/ARCHITECTURE.md',
      'docs/security/THREAT_MODEL.md',
      'docs/providers/AUTHORING.md',
      'docs/release/RELEASE.md',
      'docs/ROADMAP.md',
      'docs/KNOWN_LIMITATIONS.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'CODE_OF_CONDUCT.md',
      'LICENSE',
    ]) {
      expect(readme, `README should link ${doc}`).toContain(`(${doc})`)
    }
  })
})

describe('README claims match the repository', () => {
  it('tagline and required sections are present', async () => {
    const readme = await readText('README.md')
    expect(readme).toContain('Migration Assistant, but for developers.')
    expect(readme).toContain('Your machine. Your code. Your context.')
    expect(readme).toContain('Screenshots will be added once the UI is final')
    for (const heading of [
      '## The problem',
      '## The solution',
      '## How it works',
      '## Status',
      '## Requirements',
      '## Install',
      '## Development',
      '## Architecture',
      '## Documentation',
      '## Contributing',
      '## Security',
      '## License',
    ]) {
      expect(readme, `missing section ${heading}`).toContain(heading)
    }
    expect(readme).toContain('xattr -d com.apple.quarantine')
    expect(readme).toContain('Argon2id')
    expect(readme).toContain('AES-256-GCM')
  })

  it('development commands exist as pnpm scripts', async () => {
    const readme = await readText('README.md')
    const pkg = await readPackageJson()
    for (const script of ['dev', 'verify', 'test:e2e', 'dist:mac', 'typecheck', 'lint', 'format']) {
      expect(readme).toContain(`pnpm ${script}`)
      expect(pkg.scripts, `package.json script ${script}`).toHaveProperty(script)
    }
    expect(pkg.scripts.verify).toBe(
      'pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:unit && pnpm test:integration && pnpm build',
    )
  })

  it('node and pnpm major versions match .nvmrc and packageManager', async () => {
    const readme = await readText('README.md')
    const contributing = await readText('CONTRIBUTING.md')
    const nvmrc = (await readText('.nvmrc')).trim()
    const pkg = await readPackageJson()
    const pnpmMajor = /^pnpm@(\d+)/.exec(pkg.packageManager)?.[1]
    expect(pnpmMajor).toBeDefined()
    expect(readme).toContain(`Node ${nvmrc}`)
    expect(readme).toContain(`pnpm ${pnpmMajor}`)
    expect(contributing).toContain(`Node ${nvmrc}`)
    expect(contributing).toContain(`pnpm ${pnpmMajor}`)
  })

  it('provider status table names every v0.1 provider package and the planned ones', async () => {
    const readme = await readText('README.md')
    for (const id of ['claude-code', 'git', 'project-files', 'runtime']) {
      expect(await exists(`packages/providers/${id}/package.json`)).toBe(true)
    }
    for (const label of [
      'Claude Code',
      'Git',
      'Project files',
      'Runtime',
      'Codex CLI',
      'Cursor',
      'VS Code',
      'Ghostty',
      'Homebrew',
    ]) {
      expect(readme, `provider row ${label}`).toMatch(new RegExp(`\\|\\s*${label}\\s*\\|`))
    }
  })

  it('app and desktop package versions agree (release.yml enforces the same)', async () => {
    const root = await readPackageJson()
    const desktop = await readPackageJson('apps/desktop/package.json')
    expect(desktop.version).toBe(root.version)
  })
})

describe('GitHub workflows', () => {
  it('ci.yml runs the verify pipeline in order, then e2e, with no secrets', async () => {
    const ci = await readText('.github/workflows/ci.yml')
    const pkg = await readPackageJson()
    expect(ci).toContain('pnpm/action-setup@v4')
    expect(ci).toContain('actions/setup-node@v4')
    expect(ci).toContain('node-version-file: .nvmrc')
    expect(ci).toContain('cache: pnpm')
    expect(ci).toContain('pnpm install --frozen-lockfile')
    expect(ci).toContain('runs-on: macos-latest')
    expect(ci).toContain('cancel-in-progress: true')
    expect(ci).toContain('needs: verify')
    expect(ci).toContain('continue-on-error: false')
    expect(ci).toContain('if: failure()')
    expect(ci).toContain('playwright-report')
    expect(ci).not.toMatch(/secrets\./)

    const calls = pnpmScriptCalls(ci)
    for (const script of calls) {
      expect(pkg.scripts, `ci.yml calls pnpm ${script}`).toHaveProperty(script)
    }
    const order = ['typecheck', 'lint', 'format:check', 'test:unit', 'test:integration', 'build']
    const positions = order.map((s) => calls.indexOf(s))
    expect(
      positions.every((p) => p >= 0),
      'every verify step is called',
    ).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(calls).toContain('test:e2e')
  })

  it('release.yml triggers on v* tags and workflow_dispatch, builds unsigned by default, signs only with secrets', async () => {
    const release = await readText('.github/workflows/release.yml')
    const pkg = await readPackageJson()
    expect(release).toMatch(/tags:\s*\['v\*'\]/)
    expect(release).toContain('workflow_dispatch')
    expect(release).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(release).toContain('softprops/action-gh-release@v2')
    expect(release).toContain('draft: true')
    expect(release).toContain('generate_release_notes: true')
    expect(release).toContain('SHA256SUMS.txt')
    expect(release).toContain('actions/upload-artifact@v4')
    for (const secret of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
    ]) {
      expect(release, `release.yml references secrets.${secret}`).toContain(`secrets.${secret}`)
    }
    // Signing steps must be gated on the detection step, never unconditional.
    expect(release).toContain("if: steps.signing.outputs.sign == 'true'")
    expect(release).toContain("if: steps.signing.outputs.sign != 'true'")
    for (const script of pnpmScriptCalls(release)) {
      expect(pkg.scripts, `release.yml calls pnpm ${script}`).toHaveProperty(script)
    }
    // The desktop package must expose the scripts the signed path invokes directly.
    const desktop = await readPackageJson('apps/desktop/package.json')
    expect(desktop.scripts).toHaveProperty('dist:mac')
    expect(await exists('apps/desktop/electron-builder.yml')).toBe(true)
  })

  it('workflow YAML has no tabs and consistent two-space indentation', async () => {
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const yaml = await readText(file)
      expect(yaml, `${file} contains a tab`).not.toMatch(/\t/)
      for (const [i, line] of yaml.split('\n').entries()) {
        const indent = /^ */.exec(line)?.[0].length ?? 0
        expect(indent % 2, `${file}:${i + 1} odd indentation`).toBe(0)
      }
    }
  })
})

describe('issue and pull request templates', () => {
  it('every issue template has name/about/title/labels front matter', async () => {
    const dir = path.join(ROOT, '.github', 'ISSUE_TEMPLATE')
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'))
    expect(files.length).toBeGreaterThanOrEqual(3)
    for (const file of files) {
      const fm = frontMatter(await readText(path.join('.github', 'ISSUE_TEMPLATE', file)))
      for (const key of ['name', 'about', 'title', 'labels']) {
        expect(fm, `${file} front matter ${key}`).toHaveProperty(key)
        expect(fm[key], `${file} front matter ${key} empty`).not.toBe('')
      }
    }
  })

  it('issue template config disables blank issues and links the security advisory page', async () => {
    const config = await readText('.github/ISSUE_TEMPLATE/config.yml')
    expect(config).toContain('blank_issues_enabled: false')
    expect(config).toContain('/security/advisories/new')
  })

  it('PR template carries the hard-rules checklist', async () => {
    const pr = await readText('.github/PULL_REQUEST_TEMPLATE.md')
    for (const phrase of [
      'ScopedFs',
      'Exec(file, args[])',
      'MigrationError',
      'pnpm verify',
      'CHANGELOG.md',
    ]) {
      expect(pr).toContain(phrase)
    }
  })
})

describe('threat model and limitations keep their validation placeholders honest', () => {
  it('threat model covers every threat from the spec list', async () => {
    const tm = await readText('docs/security/THREAT_MODEL.md')
    for (const threat of [
      'Stolen backup',
      'Malicious backup input',
      'Path traversal entry',
      'Symlink / hardlink attack',
      'Restore outside the approved destination',
      'Corrupted archive',
      'Decompression bomb',
      'Manipulated manifest',
      'Renderer compromise',
      'Malicious project file names',
      'Command injection via git branch / path / remote strings',
      'Cancellation mid-operation',
      'App crash with temp files',
      'Claude Code running during restore',
    ]) {
      expect(tm, `threat row: ${threat}`).toContain(threat)
    }
    expect(tm).toContain('to be validated by the security gate')
  })

  it('KNOWN_LIMITATIONS lists the v0.1 gaps the ADRs imply', async () => {
    const kl = await readText('docs/KNOWN_LIMITATIONS.md')
    for (const phrase of [
      'Submodules',
      'Stashes',
      'Hooks',
      'Plugins are reinstalled',
      'Keychain',
      '200 characters',
      'No Windows or Linux',
      'to be finalized',
    ]) {
      expect(kl, `limitation: ${phrase}`).toContain(phrase)
    }
  })
})
