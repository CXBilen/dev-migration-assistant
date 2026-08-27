/**
 * Chunked AES-256-GCM with the age/STREAM nonce construction.
 *
 *   nonce(i, last) = BE88(i) || (last ? 0x01 : 0x00)        (12 bytes)
 *   aad(i)         = headerHash(32) || BE64(i)              (40 bytes)
 *   chunk_i        = AES-256-GCM(contentKey, nonce, plaintext_i, aad(i)) || tag(16)
 *
 * Every chunk except the last carries exactly `chunkSize` plaintext bytes. The last chunk carries
 * 0..chunkSize bytes and is flagged in its nonce, so truncation at a chunk boundary, reordering,
 * duplication and header transplants all fail authentication. Plaintext is only released after the
 * tag verified: nothing unauthenticated ever leaves the decryptor.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'
import {
  CHUNK_COUNTER_BYTES,
  CIPHER_ALGORITHM,
  CONTENT_KEY_LENGTH,
  DEFAULT_CHUNK_SIZE,
  GCM_NONCE_LENGTH,
  GCM_TAG_LENGTH,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
} from './constants'
import { integrity } from './errors'
import { MigrationError } from '@devmig/shared'

export function buildChunkNonce(index: number, last: boolean): Buffer {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('chunk index out of range')
  const nonce = Buffer.alloc(GCM_NONCE_LENGTH)
  nonce.writeBigUInt64BE(BigInt(index), CHUNK_COUNTER_BYTES - 8)
  nonce[GCM_NONCE_LENGTH - 1] = last ? 1 : 0
  return nonce
}

export function buildChunkAad(headerHash: Buffer, index: number): Buffer {
  const aad = Buffer.alloc(headerHash.length + 8)
  headerHash.copy(aad, 0)
  aad.writeBigUInt64BE(BigInt(index), headerHash.length)
  return aad
}

export interface ChunkCipherOptions {
  contentKey: Buffer
  /** SHA-256 of the raw header bytes; binds every chunk to this file's header. */
  headerHash: Buffer
  chunkSize?: number
  /** Called after every sealed/opened chunk with cumulative plaintext bytes. */
  onChunk?: (plaintextBytes: number, chunkIndex: number) => void
}

function checkOptions(opts: ChunkCipherOptions): number {
  if (opts.contentKey.length !== CONTENT_KEY_LENGTH) {
    throw new MigrationError('INVALID_INPUT', 'content key must be 32 bytes')
  }
  if (opts.headerHash.length !== 32) {
    throw new MigrationError('INVALID_INPUT', 'header hash must be 32 bytes')
  }
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new MigrationError('INVALID_INPUT', 'chunk size out of range', {
      details: { chunkSize, min: MIN_CHUNK_SIZE, max: MAX_CHUNK_SIZE },
    })
  }
  return chunkSize
}

export function sealChunk(
  key: Buffer,
  headerHash: Buffer,
  index: number,
  last: boolean,
  plaintext: Buffer,
): Buffer {
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, buildChunkNonce(index, last), {
    authTagLength: GCM_TAG_LENGTH,
  })
  cipher.setAAD(buildChunkAad(headerHash, index))
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

/** Opens one chunk. Throws INTEGRITY_MISMATCH on any authentication failure. */
export function openChunk(
  key: Buffer,
  headerHash: Buffer,
  index: number,
  last: boolean,
  ciphertext: Buffer,
): Buffer {
  if (ciphertext.length < GCM_TAG_LENGTH) {
    throw integrity(`Chunk ${index} is shorter than an authentication tag.`, {
      chunkIndex: index,
      length: ciphertext.length,
    })
  }
  const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_LENGTH)
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_LENGTH)
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, buildChunkNonce(index, last), {
      authTagLength: GCM_TAG_LENGTH,
    })
    decipher.setAAD(buildChunkAad(headerHash, index))
    decipher.setAuthTag(tag)
    const plaintext = decipher.update(body)
    decipher.final()
    return plaintext
  } catch {
    throw integrity(`Chunk ${index} failed authentication.`, { chunkIndex: index, last })
  }
}

/** Accumulates Buffers without quadratic concatenation. */
class ByteQueue {
  private parts: Buffer[] = []
  length = 0

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.parts.push(chunk)
    this.length += chunk.length
  }

  /** Removes and returns the first `n` bytes (n <= length). */
  take(n: number): Buffer {
    if (n > this.length) throw new Error('ByteQueue underflow')
    const out = Buffer.allocUnsafe(n)
    let offset = 0
    while (offset < n) {
      const head = this.parts[0]
      if (!head) throw new Error('ByteQueue corrupted')
      const need = n - offset
      if (head.length <= need) {
        head.copy(out, offset)
        offset += head.length
        this.parts.shift()
      } else {
        head.copy(out, offset, 0, need)
        this.parts[0] = head.subarray(need)
        offset += need
      }
    }
    this.length -= n
    return out
  }

  takeAll(): Buffer {
    return this.take(this.length)
  }
}

export interface EncryptStream extends Transform {
  /** Plaintext bytes consumed so far. */
  readonly bytesIn: number
  /** Ciphertext bytes produced so far. */
  readonly bytesOut: number
  readonly chunks: number
}

/** Transform: plaintext → sealed chunks. The last chunk is detected at end-of-stream. */
export function createEncryptStream(opts: ChunkCipherOptions): EncryptStream {
  const chunkSize = checkOptions(opts)
  const queue = new ByteQueue()
  let index = 0
  let bytesIn = 0
  let bytesOut = 0
  class Encryptor extends Transform {
    get bytesIn(): number {
      return bytesIn
    }
    get bytesOut(): number {
      return bytesOut
    }
    get chunks(): number {
      return index
    }
    override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
      try {
        queue.push(chunk)
        // Strictly greater: always keep at least one byte for the final (flagged) chunk.
        while (queue.length > chunkSize) {
          const pt = queue.take(chunkSize)
          const sealed = sealChunk(opts.contentKey, opts.headerHash, index, false, pt)
          bytesIn += pt.length
          bytesOut += sealed.length
          this.push(sealed)
          index += 1
          opts.onChunk?.(bytesIn, index - 1)
        }
        cb()
      } catch (err) {
        cb(err as Error)
      }
    }
    override _flush(cb: TransformCallback): void {
      try {
        const pt = queue.takeAll()
        const sealed = sealChunk(opts.contentKey, opts.headerHash, index, true, pt)
        bytesIn += pt.length
        bytesOut += sealed.length
        this.push(sealed)
        index += 1
        opts.onChunk?.(bytesIn, index - 1)
        cb()
      } catch (err) {
        cb(err as Error)
      }
    }
  }
  return new Encryptor({ highWaterMark: chunkSize })
}

export interface DecryptStreamOptions extends ChunkCipherOptions {
  /**
   * Exact ciphertext length when the source is seekable. Lets the decryptor release each chunk as
   * soon as it is complete instead of keeping a one-chunk lookahead, and detects trailing garbage.
   */
  totalCiphertextBytes?: number
}

export interface DecryptStream extends Transform {
  /** Ciphertext bytes consumed so far. */
  readonly bytesIn: number
  /** Authenticated plaintext bytes released so far. */
  readonly bytesOut: number
  readonly chunks: number
}

/** Transform: sealed chunks → authenticated plaintext. Any failure → INTEGRITY_MISMATCH. */
export function createDecryptStream(opts: DecryptStreamOptions): DecryptStream {
  const chunkSize = checkOptions(opts)
  const sealedSize = chunkSize + GCM_TAG_LENGTH
  const total = opts.totalCiphertextBytes
  if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) {
    throw new MigrationError('INVALID_INPUT', 'totalCiphertextBytes out of range')
  }
  const queue = new ByteQueue()
  let index = 0
  let consumed = 0
  let bytesIn = 0
  let bytesOut = 0
  let finished = false

  const release = (transform: Transform, ct: Buffer, last: boolean): void => {
    const pt = openChunk(opts.contentKey, opts.headerHash, index, last, ct)
    consumed += ct.length
    bytesOut += pt.length
    if (pt.length > 0) transform.push(pt)
    index += 1
    opts.onChunk?.(bytesOut, index - 1)
    if (last) finished = true
  }

  class Decryptor extends Transform {
    get bytesIn(): number {
      return bytesIn
    }
    get bytesOut(): number {
      return bytesOut
    }
    get chunks(): number {
      return index
    }
    override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
      try {
        bytesIn += chunk.length
        if (finished) {
          throw integrity('Unexpected data after the final chunk.', { chunkIndex: index })
        }
        queue.push(chunk)
        if (total !== undefined) {
          if (bytesIn > total) {
            throw integrity('The archive is longer than its declared size.', {
              expected: total,
              seen: bytesIn,
            })
          }
          for (;;) {
            const remaining = total - consumed
            if (remaining <= sealedSize) {
              // Final chunk: wait until every remaining byte arrived.
              if (queue.length >= remaining && bytesIn === total) {
                release(this, queue.take(remaining), true)
              }
              break
            }
            if (queue.length < sealedSize) break
            release(this, queue.take(sealedSize), false)
          }
        } else {
          // Non-seekable source: keep one chunk of lookahead so the last chunk is recognised at EOF.
          while (queue.length > sealedSize) {
            release(this, queue.take(sealedSize), false)
          }
        }
        cb()
      } catch (err) {
        cb(err as Error)
      }
    }
    override _flush(cb: TransformCallback): void {
      try {
        if (total !== undefined) {
          if (!finished) {
            throw integrity('The archive ended before its final chunk.', {
              chunkIndex: index,
              expected: total,
              seen: bytesIn,
            })
          }
        } else if (!finished) {
          if (queue.length === 0) {
            throw integrity('The archive ended before its final chunk.', { chunkIndex: index })
          }
          release(this, queue.takeAll(), true)
        }
        cb()
      } catch (err) {
        cb(err as Error)
      }
    }
  }
  return new Decryptor({ highWaterMark: chunkSize })
}
