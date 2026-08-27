/**
 * Tiny structured logger for the renderer. The renderer cannot use electron-log (no Node);
 * it logs to the DevTools console with a stable prefix. Never pass secrets here.
 */
type Level = 'debug' | 'info' | 'warn' | 'error'

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  const line = `[devmig] ${message}`
  const method: 'debug' | 'info' | 'warn' | 'error' = level
  if (fields) console[method](line, fields)
  else console[method](line)
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>): void =>
    emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>): void => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>): void => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>): void =>
    emit('error', message, fields),
}
