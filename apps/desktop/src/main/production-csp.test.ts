/**
 * The packaged renderer's CSP lives in apps/desktop/electron.vite.config.ts (`PRODUCTION_CSP`,
 * injected by the build-only `productionCsp()` plugin). tests/e2e/smoke.e2e.ts asserts the built HTML
 * but needs a build; this pins the source string so a regression fails in `pnpm test:unit`.
 * Read as text on purpose: importing the config would load electron-vite and the Vite plugins.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CONFIG = path.resolve(import.meta.dirname, '..', '..', 'electron.vite.config.ts')

async function productionCspDirectives(): Promise<string[]> {
  const source = await fs.readFile(CONFIG, 'utf8')
  const block = /export const PRODUCTION_CSP = \[([\s\S]*?)\]\.join\('; '\)/.exec(source)
  expect(block?.[1], 'PRODUCTION_CSP is an array literal joined with "; "').toBeDefined()
  return [...(block?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '')
}

describe('PRODUCTION_CSP', () => {
  it('locks the packaged renderer to self and names no dev origin', async () => {
    const directives = await productionCspDirectives()
    expect(directives).toEqual([
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
    ])
    const policy = directives.join('; ')
    for (const forbidden of ['localhost', '127.0.0.1', 'http:', 'https:', 'ws:', 'unsafe-eval']) {
      expect(policy, `production CSP must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })
})
