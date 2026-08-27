import { describe, expect, it } from 'vitest'
import { MigrationError, serializeError, throwIfAborted } from './errors'

describe('errors', () => {
  it('serializes MigrationError with redaction', () => {
    const err = new MigrationError(
      'GIT_COMMAND_FAILED',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked',
      {
        hint: 'retry',
        details: { stderr: 'API_KEY=secretvalue' },
        recoverable: true,
        cause: new Error('inner sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'),
      },
    )
    const s = serializeError(err)
    expect(s.code).toBe('GIT_COMMAND_FAILED')
    expect(s.message).not.toContain('ghp_')
    expect(s.hint).toBe('retry')
    expect(JSON.stringify(s.details)).not.toContain('secretvalue')
    expect(s.cause).not.toContain('sk-ant')
    expect(s.recoverable).toBe(true)
    expect(err.toJSON().code).toBe('GIT_COMMAND_FAILED')
  })

  it('maps node errno codes and abort errors', () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' })
    expect(serializeError(enoent).code).toBe('PATH_NOT_FOUND')
    expect(serializeError(Object.assign(new Error('x'), { code: 'EACCES' })).code).toBe(
      'PERMISSION_DENIED',
    )
    expect(serializeError(Object.assign(new Error('x'), { code: 'ENOSPC' })).code).toBe('DISK_FULL')
    expect(serializeError(Object.assign(new Error('x'), { name: 'AbortError' })).code).toBe(
      'CANCELLED',
    )
    expect(serializeError('plain').code).toBe('UNKNOWN')
  })

  it('throwIfAborted', () => {
    const c = new AbortController()
    expect(() => throwIfAborted(c.signal)).not.toThrow()
    c.abort()
    expect(() => throwIfAborted(c.signal)).toThrow(MigrationError)
    expect(() => throwIfAborted(undefined)).not.toThrow()
  })
})
