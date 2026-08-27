import { describe, expect, it } from 'vitest'
import { redactSecrets } from '@devmig/shared'
import { buildClaudeTranscript, readJsonl } from '@devmig/test-utils'
import { createSanitizer, sanitizeTranscript } from './sanitize'

const HOME = '/Users/realuser'
const PROJECT = `${HOME}/Documents/GitHub/looplift`

describe('sanitizeTranscript', () => {
  it('keeps shapes, redacts content, remaps paths and ids, and passes the secret check', async () => {
    const built = buildClaudeTranscript({
      sessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      cwd: PROJECT,
      gitBranch: 'feature/x',
      ordinal: 3,
      transcriptDir: `${HOME}/.claude/projects/-Users-realuser-Documents-GitHub-looplift`,
    })
    const extra = JSON.stringify({
      type: 'user',
      cwd: PROJECT,
      sessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      message: { role: 'user', content: 'export API_KEY=sk-ant-realsecretvalue1234567890 please' },
      toolUseResult: {
        type: 'text',
        filePath: `${PROJECT}/.env`,
        stdout: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      },
    })
    const input = `${[...built.lines, extra].join('\n')}\n`
    const { text, sanitizer } = sanitizeTranscript(input, { homeDir: HOME, projectPath: PROJECT })
    expect(text).not.toContain('realuser')
    expect(text).not.toContain('sk-ant-')
    expect(text).not.toContain('ghp_')
    expect(redactSecrets(text)).toBe(text)
    const lines = text.split('\n')
    expect(lines[built.lines.length - 1]).toBe('REDACTED-INVALID-LINE (8 chars)')
    const parsed = lines
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed.length).toBe(built.recordCount + 1)
    const user = parsed.find((r) => r.type === 'user') as {
      cwd: string
      message: { role: string; content: string }
      timestamp: string
      version: string
    }
    expect(user.cwd).toBe('/Users/alice/Documents/GitHub/demo')
    expect(user.message.role).toBe('user')
    expect(user.message.content).toMatch(/^REDACTED \(\d+ chars\)$/)
    expect(user.timestamp).toBe('2026-08-20T13:01:00.000Z')
    expect(user.version).toBe('2.1.247')
    const assistant = parsed.find((r) => r.type === 'assistant') as {
      message: { content: { type: string; text?: string; input?: { file_path: string } }[] }
    }
    expect(assistant.message.content[0]?.type).toBe('text')
    expect(assistant.message.content[0]?.text).toMatch(/^REDACTED/)
    expect(assistant.message.content[1]?.input?.file_path).toMatch(/^REDACTED/)
    const toolResult = parsed.find(
      (r) => r.toolUseResult && typeof r.toolUseResult === 'object',
    ) as { toolUseResult: { filePath: string; file: { filePath: string; content: string } } }
    expect(toolResult.toolUseResult.filePath).toBe('/Users/alice/Documents/GitHub/demo/README.md')
    expect(toolResult.toolUseResult.file.filePath).toBe(
      '/Users/alice/Documents/GitHub/demo/README.md',
    )
    expect(toolResult.toolUseResult.file.content).toMatch(/^REDACTED/)
    expect(
      parsed.every(
        (r) =>
          typeof r.sessionId !== 'string' ||
          r.sessionId === sanitizer.mapId('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
      ),
    ).toBe(true)
    expect(sanitizer.mapId('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')).toMatch(
      /^00000000-0000-4000-8000-[0-9a-f]{12}$/,
    )
    expect(sanitizer.redactedStrings).toBeGreaterThan(5)
    const snapshot = parsed.find((r) => r.type === 'file-history-snapshot') as {
      snapshot: { trackedFileBackups: Record<string, { realParentDir: string }> }
    }
    expect(snapshot.snapshot.trackedFileBackups['src/index.ts']?.realParentDir).toBe(
      '/Users/alice/Documents/GitHub/demo',
    )
    const { records } = await readJsonlFromText(text)
    expect(records.length).toBe(parsed.length)
  })

  it('refuses when the user name would survive', () => {
    const s = createSanitizer({ homeDir: HOME })
    expect(() => s.assertClean('/Users/realuser/x')).toThrow(/user name/)
    expect(() => s.assertClean('token=abcdefghijklmnop')).toThrow(/secret/)
    expect(() => s.assertClean('{"cwd":"/Users/alice/x"}')).not.toThrow()
  })
})

async function readJsonlFromText(text: string): Promise<{ records: Record<string, unknown>[] }> {
  const { promises: fs } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devmig-sanitize-'))
  const file = path.join(dir, 'x.jsonl')
  await fs.writeFile(file, text)
  try {
    return await readJsonl(file)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
