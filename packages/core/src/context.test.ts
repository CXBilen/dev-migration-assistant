import type { ProgressEvent } from '@devmig/model'
import { describe, expect, it } from 'vitest'
import {
  clamp01,
  detachedJobContext,
  errorMessage,
  makeBaseContext,
  makeDetectionContext,
} from './context'
import { collectingLogger, directJobContext } from './testing/engine-fixtures'
import { createFakeExec } from './testing/fake-exec'

describe('context helpers', () => {
  const env = {
    homeDir: '/h',
    claudeConfigDir: '/h/.claude',
    claudeJsonPath: '/h/.claude.json',
    env: { A: '1' },
    exec: createFakeExec(() => undefined),
    logger: collectingLogger().logger,
  }

  it('forwards progress with attribution and clamps fractions', () => {
    const events: ProgressEvent[] = []
    const job = directJobContext(env.logger, { events })
    const ctx = makeBaseContext(env, job, { projectId: 'p', providerId: 'x' })
    ctx.progress('hello', 1.7, { id: 'i', label: 'l', status: 'done' })
    ctx.progress('plain')
    expect(events[0]).toMatchObject({
      message: 'hello',
      progress: 1,
      projectId: 'p',
      providerId: 'x',
      item: { id: 'i' },
    })
    expect(events[1]).toMatchObject({ message: 'plain', projectId: 'p', providerId: 'x' })
    expect(events[1]?.progress).toBeUndefined()
    expect(ctx).toMatchObject({
      homeDir: '/h',
      claudeConfigDir: '/h/.claude',
      claudeJsonPath: '/h/.claude.json',
      env: { A: '1' },
    })
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(Number.NaN)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
  })

  it('builds detection contexts and detached job contexts that follow an external signal', () => {
    const controller = new AbortController()
    const detection = makeDetectionContext(env, controller.signal)
    expect(detection.signal).toBe(controller.signal)
    expect(makeDetectionContext(env).signal).toBeUndefined()
    const detached = detachedJobContext(env, controller.signal)
    expect(detached.signal.aborted).toBe(false)
    controller.abort()
    expect(detached.signal.aborted).toBe(true)
    expect(detachedJobContext(env, controller.signal).signal.aborted).toBe(true)
    expect(errorMessage(new Error('x'))).toBe('x')
    expect(errorMessage('y')).toBe('y')
  })
})
