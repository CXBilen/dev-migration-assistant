import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJsonl, writeJsonl, writeJsonlLines } from './jsonl'
import { withTempRoot } from './temp'

describe('readJsonl', () => {
  it('parses objects, skips blank lines and reports invalid lines with their line numbers', async () => {
    await withTempRoot(async (root) => {
      const file = path.join(root, 'a.jsonl')
      await fs.writeFile(
        file,
        [
          '{"type":"user","cwd":"/x"}',
          '',
          'not json',
          '[1,2]',
          '"str"',
          '{"type":"assistant"}',
          '',
        ].join('\n'),
      )
      const result = await readJsonl(file)
      expect(result.records).toEqual([{ type: 'user', cwd: '/x' }, { type: 'assistant' }])
      expect(result.invalidLines).toEqual([
        { lineNumber: 3, text: 'not json' },
        { lineNumber: 4, text: '[1,2]' },
        { lineNumber: 5, text: '"str"' },
      ])
    })
  })

  it('handles CRLF and a missing trailing newline', async () => {
    await withTempRoot(async (root) => {
      const file = path.join(root, 'b.jsonl')
      await fs.writeFile(file, '{"a":1}\r\n{"b":2}')
      const result = await readJsonl(file)
      expect(result.records).toEqual([{ a: 1 }, { b: 2 }])
      expect(result.invalidLines).toEqual([])
    })
  })

  it('round-trips through writeJsonl / writeJsonlLines', async () => {
    await withTempRoot(async (root) => {
      const file = path.join(root, 'nested', 'c.jsonl')
      await writeJsonl(file, [{ a: 1 }, { b: 'two' }])
      expect(await fs.readFile(file, 'utf8')).toBe('{"a":1}\n{"b":"two"}\n')
      await writeJsonlLines(file, [])
      expect(await fs.readFile(file, 'utf8')).toBe('')
      expect((await readJsonl(file)).records).toEqual([])
    })
  })
})
