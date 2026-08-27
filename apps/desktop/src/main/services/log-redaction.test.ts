import { describe, expect, it } from 'vitest'
import { redactLogMessage } from './log-redaction'

describe('redactLogMessage', () => {
  it('redacts secrets in strings, objects and errors while keeping other values', () => {
    const token = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
    const err = new Error(`failed with token=${token}`)
    const message = redactLogMessage({
      data: [
        `Authorization: Bearer ${token}`,
        { apiKey: token, nested: { password: 'hunter22' } },
        err,
        42,
        null,
      ],
    })
    const text = JSON.stringify(message.data.map((d) => (d instanceof Error ? d.message : d)))
    expect(text).not.toContain('abcdefghijklmnop')
    expect(text).not.toContain('hunter22')
    expect(text).toContain('[REDACTED]')
    expect(message.data[3]).toBe(42)
    expect(message.data[4]).toBeNull()
    expect(message.data[2]).toBeInstanceOf(Error)
  })
})
