import { randomBytes } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { GCM_TAG_LENGTH } from './constants'
import {
  buildChunkAad,
  buildChunkNonce,
  createDecryptStream,
  createEncryptStream,
  openChunk,
  sealChunk,
} from './crypto-stream'
import { expectCode } from './test-helpers'

const key = randomBytes(32)
const headerHash = randomBytes(32)
const CS = 4096

function collect(): { sink: Writable; chunks: Buffer[] } {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })
  return { sink, chunks }
}

function split(buf: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = []
  let offset = 0
  let i = 0
  while (offset < buf.length) {
    const n = sizes[i % sizes.length] as number
    out.push(buf.subarray(offset, offset + n))
    offset += n
    i += 1
  }
  return out
}

async function encrypt(pt: Buffer, writeSizes = [1000]): Promise<Buffer> {
  const { sink, chunks } = collect()
  await pipeline(
    Readable.from(split(pt, writeSizes)),
    createEncryptStream({ contentKey: key, headerHash, chunkSize: CS }),
    sink,
  )
  return Buffer.concat(chunks)
}

async function decrypt(
  ct: Buffer,
  opts: { total?: boolean; writeSizes?: number[] } = {},
): Promise<{ pt: Buffer; released: Buffer[] }> {
  const { sink, chunks } = collect()
  await pipeline(
    Readable.from(split(ct, opts.writeSizes ?? [777])),
    createDecryptStream({
      contentKey: key,
      headerHash,
      chunkSize: CS,
      ...(opts.total === false ? {} : { totalCiphertextBytes: ct.length }),
    }),
    sink,
  )
  return { pt: Buffer.concat(chunks), released: chunks }
}

describe('nonce and AAD construction', () => {
  it('encodes an 11-byte big-endian counter and a last flag', () => {
    expect(buildChunkNonce(0, false).toString('hex')).toBe('000000000000000000000000')
    expect(buildChunkNonce(1, true).toString('hex')).toBe('000000000000000000000101')
    expect(buildChunkNonce(0x0102030405, false).toString('hex')).toBe('000000000000010203040500')
  })
  it('binds the header hash and the chunk index', () => {
    const aad = buildChunkAad(headerHash, 7)
    expect(aad.length).toBe(40)
    expect(aad.subarray(0, 32).equals(headerHash)).toBe(true)
    expect(aad.readBigUInt64BE(32)).toBe(7n)
  })
  it('seal/open round trip, and wrong index / flag / header fail', () => {
    const pt = Buffer.from('hello')
    const ct = sealChunk(key, headerHash, 3, true, pt)
    expect(ct.length).toBe(pt.length + GCM_TAG_LENGTH)
    expect(openChunk(key, headerHash, 3, true, ct).equals(pt)).toBe(true)
    expect(() => openChunk(key, headerHash, 2, true, ct)).toThrow(/authentication/)
    expect(() => openChunk(key, headerHash, 3, false, ct)).toThrow(/authentication/)
    expect(() => openChunk(key, randomBytes(32), 3, true, ct)).toThrow(/authentication/)
  })
})

describe('encrypt/decrypt streams', () => {
  const sizes = [0, 1, CS - 1, CS, CS + 1, CS * 3, CS * 3 + 17]
  for (const size of sizes) {
    it(`round trips ${size} bytes (seekable and streaming modes, odd write sizes)`, async () => {
      const pt = randomBytes(size)
      const ct = await encrypt(pt, [1, 511, 4096, 3])
      const fullChunks = Math.floor(size / CS) - (size > 0 && size % CS === 0 ? 1 : 0)
      const rest = size - fullChunks * CS
      expect(ct.length).toBe(fullChunks * (CS + GCM_TAG_LENGTH) + rest + GCM_TAG_LENGTH)
      expect((await decrypt(ct)).pt.equals(pt)).toBe(true)
      expect((await decrypt(ct, { total: false, writeSizes: [5, 4096, 100] })).pt.equals(pt)).toBe(
        true,
      )
    })
  }

  it('produces identical ciphertext regardless of how the plaintext was written', async () => {
    const pt = randomBytes(CS * 2 + 100)
    const a = await encrypt(pt, [7])
    const b = await encrypt(pt, [CS * 3])
    expect(a.equals(b)).toBe(true)
  })

  it('rejects a flipped ciphertext byte and releases nothing from the bad chunk', async () => {
    const pt = randomBytes(CS * 4 + 10)
    const ct = await encrypt(pt)
    const offset = (CS + GCM_TAG_LENGTH) * 2 + 5 // inside chunk 2
    ct[offset] = (ct[offset] as number) ^ 0xff
    const { sink, chunks } = collect()
    const err = await expectCode(
      pipeline(
        Readable.from([ct]),
        createDecryptStream({
          contentKey: key,
          headerHash,
          chunkSize: CS,
          totalCiphertextBytes: ct.length,
        }),
        sink,
      ),
      'INTEGRITY_MISMATCH',
    )
    expect(err.details?.chunkIndex).toBe(2)
    expect(Buffer.concat(chunks).length).toBeLessThanOrEqual(CS * 2)
  })

  it('rejects swapped, dropped, duplicated and reordered chunks', async () => {
    const pt = randomBytes(CS * 4 + 10)
    const ct = await encrypt(pt)
    const sealed = CS + GCM_TAG_LENGTH
    const chunk = (i: number): Buffer =>
      ct.subarray(i * sealed, Math.min((i + 1) * sealed, ct.length))
    const swapped = Buffer.concat([chunk(0), chunk(2), chunk(1), chunk(3), chunk(4)])
    await expectCode(decrypt(swapped), 'INTEGRITY_MISMATCH')
    const dropped = Buffer.concat([chunk(0), chunk(2), chunk(3), chunk(4)])
    await expectCode(decrypt(dropped), 'INTEGRITY_MISMATCH')
    const duplicated = Buffer.concat([chunk(0), chunk(1), chunk(1), chunk(2), chunk(3), chunk(4)])
    await expectCode(decrypt(duplicated), 'INTEGRITY_MISMATCH')
  })

  it('rejects truncation at a chunk boundary, mid-chunk, and appended junk (both modes)', async () => {
    const pt = randomBytes(CS * 3 + 10)
    const ct = await encrypt(pt)
    const sealed = CS + GCM_TAG_LENGTH
    for (const total of [true, false]) {
      await expectCode(decrypt(ct.subarray(0, sealed * 2), { total }), 'INTEGRITY_MISMATCH')
      await expectCode(decrypt(ct.subarray(0, sealed * 2 + 100), { total }), 'INTEGRITY_MISMATCH')
      await expectCode(decrypt(ct.subarray(0, ct.length - 1), { total }), 'INTEGRITY_MISMATCH')
      await expectCode(
        decrypt(Buffer.concat([ct, Buffer.from('junk')]), { total }),
        'INTEGRITY_MISMATCH',
      )
      await expectCode(decrypt(Buffer.alloc(0), { total }), 'INTEGRITY_MISMATCH')
      await expectCode(decrypt(ct.subarray(0, 5), { total }), 'INTEGRITY_MISMATCH')
    }
  })

  it('rejects ciphertext sealed under a different header hash or key', async () => {
    const pt = randomBytes(100)
    const ct = await encrypt(pt)
    const { sink } = collect()
    await expectCode(
      pipeline(
        Readable.from([ct]),
        createDecryptStream({ contentKey: key, headerHash: randomBytes(32), chunkSize: CS }),
        sink,
      ),
      'INTEGRITY_MISMATCH',
    )
    const { sink: sink2 } = collect()
    await expectCode(
      pipeline(
        Readable.from([ct]),
        createDecryptStream({ contentKey: randomBytes(32), headerHash, chunkSize: CS }),
        sink2,
      ),
      'INTEGRITY_MISMATCH',
    )
  })

  it('validates its options', () => {
    expect(() => createEncryptStream({ contentKey: randomBytes(16), headerHash })).toThrow()
    expect(() => createEncryptStream({ contentKey: key, headerHash: randomBytes(4) })).toThrow()
    expect(() => createEncryptStream({ contentKey: key, headerHash, chunkSize: 100 })).toThrow()
    expect(() =>
      createDecryptStream({ contentKey: key, headerHash, totalCiphertextBytes: -1 }),
    ).toThrow()
  })
})
