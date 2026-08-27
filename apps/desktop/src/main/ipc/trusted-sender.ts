/**
 * Sender validation for every IPC request (ADR-0007, security checklist #17).
 * A request is trusted only when it comes from the MAIN frame of a BrowserWindow this process created
 * and that frame currently shows our renderer (the bundled file:// page or, in development, the Vite
 * dev server origin).
 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'

export interface SenderGuardOptions {
  /** Origin of the Vite dev server (development only), e.g. "http://localhost:5173". */
  devOrigin: string | null
  /** file:// URL of the bundled renderer page (production / built app). */
  rendererFileUrl: string | null
}

export interface SenderGuard {
  /** Registers a WebContents we created; forgotten automatically when it is destroyed. */
  trust(contents: WebContents): void
  isTrustedSender(event: IpcMainInvokeEvent): boolean
  isTrustedUrl(url: string): boolean
  trustedIds(): number[]
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

export function createSenderGuard(options: SenderGuardOptions): SenderGuard {
  const trusted = new Set<number>()
  const devOrigin = options.devOrigin ? (parseUrl(options.devOrigin)?.origin ?? null) : null
  const rendererFile = options.rendererFileUrl ? parseUrl(options.rendererFileUrl) : null

  const isTrustedUrl = (value: string): boolean => {
    const url = parseUrl(value)
    if (!url) return false
    if (url.protocol === 'file:') {
      if (!rendererFile || rendererFile.protocol !== 'file:') return false
      // Ignore the hash router state and any query string; compare the document path only.
      return url.pathname === rendererFile.pathname && url.host === rendererFile.host
    }
    if (devOrigin && (url.protocol === 'http:' || url.protocol === 'https:')) {
      return url.origin === devOrigin
    }
    return false
  }

  return {
    trust(contents) {
      trusted.add(contents.id)
      contents.once('destroyed', () => {
        trusted.delete(contents.id)
      })
    },
    isTrustedSender(event) {
      const frame = event.senderFrame
      if (!frame) return false
      const sender = event.sender
      if (!sender || sender.isDestroyed()) return false
      if (!trusted.has(sender.id)) return false
      if (frame !== sender.mainFrame) return false
      return isTrustedUrl(frame.url)
    },
    isTrustedUrl,
    trustedIds: () => [...trusted],
  }
}
