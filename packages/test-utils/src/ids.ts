import { createHash } from 'node:crypto'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Deterministic UUID that still satisfies the v4 format (version nibble 4, RFC variant).
 * The first 20 hex digits derive from sha256(namespace); the last 12 encode `index`, so ids are
 * readable in test output (…-000000000001, …-000000000002).
 */
export function deterministicUuid(namespace: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffffffff) {
    throw new RangeError(`deterministicUuid index out of range: ${index}`)
  }
  const hex = createHash('sha256').update(namespace, 'utf8').digest('hex')
  const p1 = hex.slice(0, 8)
  const p2 = hex.slice(8, 12)
  const p3 = `4${hex.slice(13, 16)}`
  const variantNibble = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)
  const p4 = `${variantNibble}${hex.slice(17, 20)}`
  const p5 = index.toString(16).padStart(12, '0')
  return `${p1}-${p2}-${p3}-${p4}-${p5}`
}

export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value)
}

/** Small deterministic PRNG (mulberry32) so "random" binary fixture bytes are reproducible. */
export function seededBytes(seed: number, length: number): Buffer {
  let a = seed >>> 0
  const out = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff
  }
  return out
}
