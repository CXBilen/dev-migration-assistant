import { describe, expect, it } from 'vitest'
import { createFakeWebContents, createInvokeEvent } from '../testing/electron-mock'
import { createSenderGuard } from './trusted-sender'
import type { IpcMainInvokeEvent, WebContents } from 'electron'

const RENDERER =
  'file:///Applications/Dev%20Migration%20Assistant.app/Contents/out/renderer/index.html'

function guard(devOrigin: string | null = null) {
  return createSenderGuard({ devOrigin, rendererFileUrl: RENDERER })
}

function asEvent(event: unknown): IpcMainInvokeEvent {
  return event as IpcMainInvokeEvent
}

describe('createSenderGuard', () => {
  it('trusts the main frame of a registered window showing the bundled page (hash router ignored)', () => {
    const g = guard()
    const contents = createFakeWebContents(`${RENDERER}#/backup/projects`)
    g.trust(contents as unknown as WebContents)
    expect(g.isTrustedSender(asEvent(createInvokeEvent(contents)))).toBe(true)
  })

  it('rejects a null senderFrame (navigated or destroyed frame)', () => {
    const g = guard()
    const contents = createFakeWebContents(RENDERER)
    g.trust(contents as unknown as WebContents)
    expect(g.isTrustedSender(asEvent(createInvokeEvent(contents, null)))).toBe(false)
  })

  it('rejects sub-frames even inside a trusted window', () => {
    const g = guard()
    const contents = createFakeWebContents(RENDERER)
    g.trust(contents as unknown as WebContents)
    const iframe = { url: RENDERER }
    expect(g.isTrustedSender(asEvent(createInvokeEvent(contents, iframe)))).toBe(false)
  })

  it('rejects WebContents the app did not create', () => {
    const g = guard()
    const stranger = createFakeWebContents(RENDERER)
    expect(g.isTrustedSender(asEvent(createInvokeEvent(stranger)))).toBe(false)
  })

  it('rejects foreign origins and other file paths', () => {
    const g = guard('http://localhost:5173')
    for (const url of [
      'https://github.com/',
      'http://localhost:5173.attacker.com/',
      'http://localhost:1234/',
      'file:///etc/passwd',
      'file:///Applications/Other.app/index.html',
      'about:blank',
      'not a url',
    ]) {
      const contents = createFakeWebContents(url)
      g.trust(contents as unknown as WebContents)
      expect(g.isTrustedSender(asEvent(createInvokeEvent(contents))), url).toBe(false)
    }
  })

  it('accepts the exact dev server origin only when configured', () => {
    const dev = guard('http://localhost:5173')
    const prod = guard(null)
    const contents = createFakeWebContents('http://localhost:5173/#/')
    dev.trust(contents as unknown as WebContents)
    prod.trust(contents as unknown as WebContents)
    expect(dev.isTrustedSender(asEvent(createInvokeEvent(contents)))).toBe(true)
    expect(prod.isTrustedSender(asEvent(createInvokeEvent(contents)))).toBe(false)
  })

  it('rejects destroyed senders and forgets a WebContents once it is destroyed', () => {
    const g = guard()
    const destroyed = createFakeWebContents(RENDERER, { destroyed: true })
    g.trust(destroyed as unknown as WebContents)
    expect(g.isTrustedSender(asEvent(createInvokeEvent(destroyed)))).toBe(false)

    const contents = createFakeWebContents(RENDERER)
    g.trust(contents as unknown as WebContents)
    expect(g.trustedIds()).toContain(contents.id)
    contents.emit('destroyed')
    expect(g.trustedIds()).not.toContain(contents.id)
  })
})
