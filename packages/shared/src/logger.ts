import { redactObject, redactSecrets } from './redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LogRecord {
  level: LogLevel
  msg: string
  time: string
  ctx: Record<string, unknown>
}
export type LogSink = (record: LogRecord) => void

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
  /** Returns a logger that merges the given context (jobId, providerId, projectId...) into every record. */
  child(ctx: Record<string, unknown>): Logger
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Structured logger. Every message and context value is passed through the secret redactor before reaching a sink. */
export function createLogger(
  sink: LogSink,
  base: Record<string, unknown> = {},
  minLevel: LogLevel = 'debug',
): Logger {
  const emit = (level: LogLevel, msg: string, ctx?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
    sink({
      level,
      msg: redactSecrets(msg),
      time: new Date().toISOString(),
      ctx: redactObject({ ...base, ...(ctx ?? {}) }),
    })
  }
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (ctx) => createLogger(sink, { ...base, ...ctx }, minLevel),
  }
}

export const noopLogger: Logger = createLogger(() => {}, {}, 'error')

export function consoleSink(record: LogRecord): void {
  const line = JSON.stringify(record)
  if (record.level === 'error') console.error(line)
  else if (record.level === 'warn') console.warn(line)
  else console.log(line)
}
