/**
 * electron-log wiring: one rotating file under app.getPath('logs') and a redaction hook that runs
 * before any transport. The structured `Logger` from @devmig/shared already redacts every message and
 * context value; the hook is the second line of defence for anything logged directly via electron-log.
 */
import path from 'node:path'
import log from 'electron-log/main'
import { createLogger, type Logger, type LogRecord } from '@devmig/shared'
import { redactLogMessage } from './log-redaction'

export const LOG_FILE_NAME = 'main.log'

export interface LoggingOptions {
  logsDirectory: string
  isPackaged: boolean
}

export interface AppLogging {
  logger: Logger
  logsDirectory: string
  logFile: string
}

let installed = false

export function initLogging(options: LoggingOptions): AppLogging {
  const logFile = path.join(options.logsDirectory, LOG_FILE_NAME)
  if (!installed) {
    installed = true
    log.transports.file.resolvePathFn = () => logFile
    log.transports.file.level = options.isPackaged ? 'info' : 'debug'
    log.transports.file.maxSize = 5 * 1024 * 1024
    log.transports.console.level = options.isPackaged ? false : 'debug'
    log.hooks.push((message) => redactLogMessage(message))
    log.errorHandler.startCatching({ showDialog: false })
  }
  const sink = (record: LogRecord): void => {
    const ctx = Object.keys(record.ctx).length > 0 ? record.ctx : undefined
    const line = ctx ? [record.msg, JSON.stringify(ctx)] : [record.msg]
    switch (record.level) {
      case 'debug':
        log.debug(...line)
        break
      case 'info':
        log.info(...line)
        break
      case 'warn':
        log.warn(...line)
        break
      case 'error':
        log.error(...line)
        break
    }
  }
  return {
    logger: createLogger(sink, { process: 'main' }, options.isPackaged ? 'info' : 'debug'),
    logsDirectory: options.logsDirectory,
    logFile,
  }
}
