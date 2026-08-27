import { IpcError } from '@devmig/ipc-contracts'
import { describe, expect, it } from 'vitest'
import { errorTitle, isCancelled, toSerializedError } from './errors'

describe('toSerializedError', () => {
  it('normalizes IpcError, plain errors, aborts and strings', () => {
    expect(
      toSerializedError(new IpcError('ARCHIVE_AUTH_FAILED', 'nope', 'hint', { a: 1 }, true)),
    ).toEqual({
      code: 'ARCHIVE_AUTH_FAILED',
      message: 'nope',
      hint: 'hint',
      details: { a: 1 },
      recoverable: true,
    })
    expect(toSerializedError(new Error('boom'))).toMatchObject({ code: 'UNKNOWN', message: 'boom' })
    expect(toSerializedError(Object.assign(new Error('x'), { name: 'AbortError' }))).toMatchObject({
      code: 'CANCELLED',
    })
    expect(toSerializedError('plain')).toMatchObject({ code: 'UNKNOWN', message: 'plain' })
    expect(toSerializedError({ code: 'not-a-code', message: 'm' })).toMatchObject({
      code: 'UNKNOWN',
      message: 'm',
    })
    expect(toSerializedError(null)).toMatchObject({ code: 'UNKNOWN' })
  })
  it('titles and cancellation', () => {
    expect(errorTitle('DISK_FULL')).toBe('Not enough disk space')
    expect(errorTitle('UNKNOWN')).toBe('Something went wrong')
    expect(isCancelled({ code: 'CANCELLED', message: '', recoverable: true })).toBe(true)
    expect(isCancelled(null)).toBe(false)
  })
})
