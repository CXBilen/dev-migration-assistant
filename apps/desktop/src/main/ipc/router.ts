/**
 * The only way handlers are attached to ipcMain. Every channel goes through the same pipeline:
 *   1. trusted-sender check  → PERMISSION_DENIED envelope (and a log line) otherwise
 *   2. zod request validation → INVALID_INPUT envelope (issues summarised, payload never echoed)
 *   3. handler
 *   4. zod response validation → the renderer never receives data outside the contract
 *   5. any throw → serialized MigrationError envelope
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  IpcChannels,
  type IpcChannelName,
  type IpcEnvelope,
  type IpcResponse,
} from '@devmig/ipc-contracts'
import { serializeError, type Logger } from '@devmig/shared'
import type { z } from 'zod'

export type IpcRequestOut<C extends IpcChannelName> = z.output<(typeof IpcChannels)[C]['request']>

export interface HandlerContext {
  event: IpcMainInvokeEvent
  /** The BrowserWindow the request came from (used to attach dialogs as sheets). */
  window: BrowserWindow | null
}

export type Handler<C extends IpcChannelName> = (
  input: IpcRequestOut<C>,
  ctx: HandlerContext,
) => Promise<IpcResponse<C>> | IpcResponse<C>

/** Every channel exactly once: the mapped type refuses missing and unknown keys at compile time. */
export type HandlerMap = { [C in IpcChannelName]: Handler<C> }

export interface RouterOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  logger: Logger
  /** Channels that carry secrets in the request (never logged, even at debug level). */
  windowFor?: (event: IpcMainInvokeEvent) => BrowserWindow | null
}

export interface Router {
  registerHandler<C extends IpcChannelName>(channel: C, handler: Handler<C>): void
  registerAll(handlers: HandlerMap): IpcChannelName[]
  registered(): IpcChannelName[]
  dispose(): void
}

export const IPC_CHANNEL_NAMES = Object.keys(IpcChannels) as IpcChannelName[]

function summarizeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.slice(0, 10).map((issue) => {
    const where = issue.path.map((p) => String(p)).join('.')
    return where ? `${where}: ${issue.message}` : issue.message
  })
}

export function createRouter(options: RouterOptions): Router {
  const registered = new Set<IpcChannelName>()
  const logger = options.logger.child({ component: 'ipc' })
  const windowFor =
    options.windowFor ??
    ((event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender))

  function registerHandler<C extends IpcChannelName>(channel: C, handler: Handler<C>): void {
    if (!(channel in IpcChannels)) {
      throw new Error(`Unknown IPC channel: ${String(channel)}`)
    }
    if (registered.has(channel)) {
      throw new Error(`IPC channel registered twice: ${channel}`)
    }
    registered.add(channel)
    const schemas = IpcChannels[channel]
    ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcEnvelope> => {
      if (!options.isTrustedSender(event)) {
        logger.warn('Rejected IPC request from an untrusted sender', {
          channel,
          senderId: event.sender?.id,
          frameUrl: event.senderFrame?.url,
        })
        return {
          ok: false,
          error: {
            code: 'PERMISSION_DENIED',
            message: 'This request did not come from the application window.',
            recoverable: false,
          },
        }
      }
      const parsed = schemas.request.safeParse(raw)
      if (!parsed.success) {
        const issues = summarizeIssues(parsed.error.issues)
        logger.warn('Rejected IPC request with an invalid payload', { channel, issues })
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: `Invalid request for ${channel}.`,
            details: { issues },
            recoverable: false,
          },
        }
      }
      try {
        const result = await handler(parsed.data as IpcRequestOut<C>, {
          event,
          window: windowFor(event),
        })
        const validated = schemas.response.safeParse(result)
        if (!validated.success) {
          logger.error('IPC handler produced a response outside the contract', {
            channel,
            issues: summarizeIssues(validated.error.issues),
          })
          return {
            ok: false,
            error: {
              code: 'UNKNOWN',
              message: 'Internal error: the response did not match the IPC contract.',
              recoverable: false,
            },
          }
        }
        return { ok: true, data: validated.data }
      } catch (err) {
        const serialized = serializeError(err)
        const level = serialized.code === 'CANCELLED' ? 'info' : 'warn'
        logger[level]('IPC handler failed', {
          channel,
          code: serialized.code,
          message: serialized.message,
        })
        return { ok: false, error: serialized }
      }
    })
  }

  return {
    registerHandler,
    registerAll(handlers) {
      for (const channel of IPC_CHANNEL_NAMES) {
        registerHandler(channel, handlers[channel] as Handler<typeof channel>)
      }
      return [...registered]
    },
    registered: () => [...registered],
    dispose() {
      for (const channel of registered) ipcMain.removeHandler(channel)
      registered.clear()
    },
  }
}
