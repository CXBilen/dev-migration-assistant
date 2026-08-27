/**
 * Pure redaction step applied to every electron-log message before any transport sees it.
 * Kept free of Electron imports so it can be unit tested without mocking.
 */
import { redactObject, redactSecrets } from '@devmig/shared'

export interface RedactableLogMessage {
  data: unknown[]
}

export function redactLogMessage<T extends RedactableLogMessage>(message: T): T {
  message.data = message.data.map((item) => {
    if (typeof item === 'string') return redactSecrets(item)
    if (item instanceof Error) {
      const copy = new Error(redactSecrets(item.message))
      copy.name = item.name
      copy.stack = item.stack ? redactSecrets(item.stack) : undefined
      return copy
    }
    if (item && typeof item === 'object') return redactObject(item)
    return item
  })
  return message
}
