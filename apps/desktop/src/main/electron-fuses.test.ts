/**
 * electron-builder.yml is the only place the packaged-app fuses are declared (ADR-0007,
 * THREAT_MODEL §5). Nothing else reads it at test time, so a silent edit would ship unnoticed until
 * someone ran `@electron/fuses read` on a DMG. This test pins every declared value.
 * The block is read with a small indentation-aware reader because the workspace has no YAML parser.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CONFIG = path.resolve(import.meta.dirname, '..', '..', 'electron-builder.yml')

/** Reads the `key: value` pairs of the two-space-indented block under `electronFuses:`. */
async function readFuseBlock(): Promise<Record<string, string>> {
  const lines = (await fs.readFile(CONFIG, 'utf8')).split('\n')
  const start = lines.indexOf('electronFuses:')
  expect(start, 'electron-builder.yml declares an electronFuses block').toBeGreaterThanOrEqual(0)
  const out: Record<string, string> = {}
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break
    const match = /^ {2}([A-Za-z][A-Za-z0-9]*): *(\S+)\s*$/.exec(line)
    if (!match?.[1] || !match[2]) continue
    out[match[1]] = match[2]
  }
  return out
}

describe('electron-builder fuses', () => {
  it('declares every ADR-0007 fuse with the expected value in electron-builder.yml', async () => {
    const fuses = await readFuseBlock()
    // ADR-0007 required set: node execution surfaces off, asar integrity on.
    expect(fuses.runAsNode).toBe('false')
    expect(fuses.enableNodeOptionsEnvironmentVariable).toBe('false')
    expect(fuses.enableNodeCliInspectArguments).toBe('false')
    expect(fuses.onlyLoadAppFromAsar).toBe('true')
    expect(fuses.enableEmbeddedAsarIntegrityValidation).toBe('true')
    // The remaining declared values, so changing any of them has to be deliberate.
    expect(fuses.enableCookieEncryption).toBe('true')
    expect(fuses.loadBrowserProcessSpecificV8Snapshot).toBe('false')
    expect(fuses.grantFileProtocolExtraPrivileges).toBe('true')
    expect(fuses.resetAdHocDarwinSignature).toBe('true')
    // No fuse may be added or removed without updating ADR-0007 and this list.
    expect(Object.keys(fuses).sort()).toEqual([
      'enableCookieEncryption',
      'enableEmbeddedAsarIntegrityValidation',
      'enableNodeCliInspectArguments',
      'enableNodeOptionsEnvironmentVariable',
      'grantFileProtocolExtraPrivileges',
      'loadBrowserProcessSpecificV8Snapshot',
      'onlyLoadAppFromAsar',
      'resetAdHocDarwinSignature',
      'runAsNode',
    ])
  })
})
