import { createHash, randomUUID } from 'node:crypto'

export function newId(prefix?: string): string {
  const id = randomUUID()
  return prefix ? `${prefix}_${id}` : id
}

/** Stable short id derived from a string (e.g. a canonical path) — 16 hex chars of SHA-256. */
export function stableId(input: string, length = 16): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length)
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}
