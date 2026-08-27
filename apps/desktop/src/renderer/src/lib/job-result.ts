import { JobResultSchemas } from '@devmig/ipc-contracts'
import type { JobSnapshot } from '@devmig/model'
import type { z } from 'zod'

export type JobResultKind = keyof typeof JobResultSchemas
export type JobResultOf<K extends JobResultKind> = z.output<(typeof JobResultSchemas)[K]>

/**
 * Validates a completed job's result against the schema for its kind. The bridge already
 * validates responses, but the renderer re-checks at this boundary so a malformed result can
 * never reach a screen as a typed value.
 */
export function parseJobResult<K extends JobResultKind>(
  kind: K,
  snapshot: JobSnapshot | undefined,
): JobResultOf<K> | null {
  if (!snapshot || snapshot.status !== 'completed') return null
  const parsed = JobResultSchemas[kind].safeParse(snapshot.result)
  return parsed.success ? (parsed.data as JobResultOf<K>) : null
}

export function isTerminal(status: JobSnapshot['status'] | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
