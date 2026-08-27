/** Detection of running Claude Code processes via the live session registry (research §14). */
import path from 'node:path'
import { readOptionalJson, listDirectory } from './fs-helpers'
import { SessionsRegistryEntrySchema } from './schema'

export type IsProcessAlive = (pid: number) => boolean

/** Default liveness probe: signal 0. EPERM means the process exists but belongs to someone else. */
export const defaultIsProcessAlive: IsProcessAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface LiveSession {
  pid: number
  cwd?: string
  sessionId?: string
}

/** Parses <claudeConfigDir>/sessions/*.json and returns the entries whose pid is alive. */
export async function findRunningClaudeSessions(
  claudeConfigDir: string,
  isAlive: IsProcessAlive = defaultIsProcessAlive,
): Promise<LiveSession[]> {
  const dir = path.join(claudeConfigDir, 'sessions')
  const live: LiveSession[] = []
  for (const entry of await listDirectory(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    let raw: unknown
    try {
      raw = await readOptionalJson(path.join(dir, entry.name))
    } catch {
      continue
    }
    const parsed = SessionsRegistryEntrySchema.safeParse(raw)
    if (!parsed.success || parsed.data.pid === undefined) continue
    if (!isAlive(parsed.data.pid)) continue
    const session: LiveSession = { pid: parsed.data.pid }
    if (parsed.data.cwd) session.cwd = parsed.data.cwd
    if (parsed.data.sessionId) session.sessionId = parsed.data.sessionId
    live.push(session)
  }
  return live
}
