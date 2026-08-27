import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactSecrets } from '@devmig/shared'
import { readJsonl } from '@devmig/test-utils'
import { sampleTranscriptMetadata } from './transcript'

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../../../fixtures/claude/sample-session')

describe('fixtures/claude/sample-session', () => {
  it('is sanitized: parses, contains no real user paths and no secret-looking values', async () => {
    const files = (await fs.readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const full = path.join(FIXTURE_DIR, file)
      const text = await fs.readFile(full, 'utf8')
      expect(text).not.toContain('/Users/cxbilen')
      expect(text).not.toMatch(/cxbilen/)
      expect(redactSecrets(text)).toBe(text)
      const { records, invalidLines } = await readJsonl(full)
      expect(records.length).toBeGreaterThan(5)
      expect(invalidLines.length).toBe(0)
      const meta = await sampleTranscriptMetadata(full)
      expect(meta.sessionId).toBe(path.basename(file, '.jsonl'))
      expect([...meta.cwds]).toEqual(['/Users/alice/Documents/GitHub/demo'])
      expect(meta.versions.size).toBeGreaterThan(0)
      for (const record of records) {
        const message = record.message as { content?: unknown } | undefined
        if (typeof message?.content === 'string')
          expect(message.content).toMatch(/^REDACTED \(\d+ chars\)$/)
      }
    }
    const readme = await fs.readFile(path.join(FIXTURE_DIR, 'README.md'), 'utf8')
    expect(readme).toContain('Never commit raw transcripts')
  })
})
