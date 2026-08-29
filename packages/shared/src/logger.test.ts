/**
 * createLogger is the only sink boundary in the app: message, context and the child base context must
 * all pass through the redactor before a record reaches a transport (THREAT_MODEL T15). The Electron
 * transport on top of it is covered by apps/desktop/src/main/services/log-redaction.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { createLogger, noopLogger, type LogRecord } from './logger'

const TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

function collect(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = []
  return { records, sink: (record) => records.push(record) }
}

describe('createLogger', () => {
  it('redacts secret-looking text in the message before it reaches the sink', () => {
    const { records, sink } = collect()
    const log = createLogger(sink, { machine: 'A' })
    log.info(`using token=${TOKEN}`)
    expect(records).toHaveLength(1)
    expect(records[0]?.msg).toContain('[REDACTED]')
    expect(records[0]?.msg).not.toContain('abcdefghijklmnop')
    expect(records[0]?.level).toBe('info')
    expect(records[0]?.ctx).toEqual({ machine: 'A' })
    expect(Number.isNaN(Date.parse(records[0]?.time ?? ''))).toBe(false)
  })

  it('redacts sensitive context keys, nested values and the child base context', () => {
    const { records, sink } = collect()
    const log = createLogger(sink, { machine: 'A' })
    log.warn('ctx', { apiKey: TOKEN, nested: { password: 'hunter22' }, projectId: 'p1' })
    const warned = JSON.stringify(records[0]?.ctx)
    expect(warned).not.toContain(TOKEN)
    expect(warned).not.toContain('hunter22')
    expect(records[0]?.ctx.projectId).toBe('p1')
    expect(records[0]?.ctx.machine).toBe('A')

    log.child({ jobId: 'job_1', authorization: `Bearer ${TOKEN}` }).error('boom')
    expect(records[1]?.level).toBe('error')
    expect(JSON.stringify(records[1]?.ctx)).not.toContain(TOKEN)
    expect(records[1]?.ctx.jobId).toBe('job_1')
    expect(records[1]?.ctx.authorization).toBe('[REDACTED]')
    // The child does not leak its context back into the parent.
    log.info('plain')
    expect(records[2]?.ctx).toEqual({ machine: 'A' })
  })

  it('drops records below the minimum level, in the child logger too', () => {
    const { records, sink } = collect()
    const log = createLogger(sink, {}, 'warn')
    log.debug('d')
    log.info('i')
    expect(records).toEqual([])
    log.warn('w')
    log.child({ jobId: 'job_2' }).debug('still filtered')
    log.child({ jobId: 'job_2' }).error('e')
    expect(records.map((r) => r.msg)).toEqual(['w', 'e'])
  })

  it('noopLogger swallows every level without throwing', () => {
    expect(() => {
      noopLogger.debug('d')
      noopLogger.info('i')
      noopLogger.warn('w')
      noopLogger.error(`token=${TOKEN}`)
      noopLogger.child({ jobId: 'job_3' }).error('nested')
    }).not.toThrow()
  })
})
