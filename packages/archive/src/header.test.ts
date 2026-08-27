import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FAST_KDF_PARAMS, FIXED_PREFIX_LENGTH, MAX_HEADER_JSON_LENGTH } from './constants'
import { buildHeader, encodeHeader, parseHeaderBytes, readDevBackupHeader } from './header'
import { expectCode, makeTempDir, removeTempDir } from './test-helpers'

const base = buildHeader({
  chunkSize: 65536,
  kdf: { ...FAST_KDF_PARAMS, saltBase64: Buffer.alloc(16, 1).toString('base64') },
  wrappedMasterKey: Buffer.alloc(60, 2).toString('base64'),
  createdAt: '2026-08-27T10:00:00.000Z',
  backupId: 'backup_x',
  appVersion: '0.1.0',
})

describe('header codec', () => {
  it('serialises with the fixed key order and binary prefix', () => {
    const bytes = encodeHeader(base)
    expect(bytes.subarray(0, 6).toString('ascii')).toBe('DEVBKP')
    expect(bytes.readUInt16BE(6)).toBe(1)
    expect(bytes.readUInt32BE(8)).toBe(bytes.length - FIXED_PREFIX_LENGTH)
    const json = bytes.subarray(FIXED_PREFIX_LENGTH).toString('utf8')
    expect(
      json.startsWith(
        '{"magic":"DEVBKP","formatVersion":1,"cipher":"aes-256-gcm","chunkSize":65536,"kdf":{"algorithm":"argon2id","memoryKiB":8192,"iterations":1,"parallelism":1,"saltBase64":"',
      ),
    ).toBe(true)
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      'magic',
      'formatVersion',
      'cipher',
      'chunkSize',
      'kdf',
      'wrappedMasterKey',
      'createdAt',
      'backupId',
      'appVersion',
    ])
  })

  it('round trips through parseHeaderBytes', () => {
    const bytes = encodeHeader(base)
    const parsed = parseHeaderBytes(
      Buffer.concat([bytes, Buffer.from('payload')]),
      bytes.length + 7,
    )
    expect(parsed.supported).toBe(true)
    expect(parsed.header).toEqual(base)
    expect(parsed.payloadOffset).toBe(bytes.length)
    expect(parsed.headerBytes.equals(bytes)).toBe(true)
  })

  it('rejects bad magic, short input, bad length, version 0 and truncated JSON', () => {
    const bytes = encodeHeader(base)
    expect(() => parseHeaderBytes(Buffer.from('DEVBKQ'), 6)).toThrow(/too short/)
    const badMagic = Buffer.from(bytes)
    badMagic.write('NOPE', 0)
    expect(() => parseHeaderBytes(badMagic, badMagic.length)).toThrow(/magic/)
    const v0 = Buffer.from(bytes)
    v0.writeUInt16BE(0, 6)
    expect(() => parseHeaderBytes(v0, v0.length)).toThrow(/version 0/)
    const big = Buffer.from(bytes)
    big.writeUInt32BE(MAX_HEADER_JSON_LENGTH + 1, 8)
    expect(() => parseHeaderBytes(big, big.length)).toThrow(/header length/i)
    expect(() => parseHeaderBytes(bytes.subarray(0, bytes.length - 3), bytes.length - 3)).toThrow(
      /truncated/,
    )
    const broken = Buffer.from(bytes)
    broken.write('X', FIXED_PREFIX_LENGTH)
    expect(() => parseHeaderBytes(broken, broken.length)).toThrow(/valid JSON/)
  })

  it('rejects headers that disagree with the binary version, weak KDF params or bad wrapped keys', () => {
    const mismatch = encodeHeader({ ...base, formatVersion: 1 })
    mismatch.writeUInt16BE(1, 6)
    const jsonPatched = Buffer.from(
      mismatch.toString('latin1').replace('"formatVersion":1', '"formatVersion":3'),
      'latin1',
    )
    jsonPatched.writeUInt16BE(1, 6)
    expect(() => parseHeaderBytes(jsonPatched, jsonPatched.length)).toThrow(/malformed|disagrees/)

    const weak = encodeHeader({ ...base, kdf: { ...base.kdf, memoryKiB: 1024 } })
    expect(() => parseHeaderBytes(weak, weak.length)).toThrow(/malformed/)
    const huge = encodeHeader({ ...base, kdf: { ...base.kdf, memoryKiB: 8 * 1024 * 1024 } })
    expect(() => parseHeaderBytes(huge, huge.length)).toThrow(/malformed/)
    const shortKey = encodeHeader({
      ...base,
      wrappedMasterKey: Buffer.alloc(32).toString('base64'),
    })
    expect(() => parseHeaderBytes(shortKey, shortKey.length)).toThrow(/wrapped master key/)
    const badB64 = encodeHeader({ ...base, wrappedMasterKey: '!!!not-base64' })
    expect(() => parseHeaderBytes(badB64, badB64.length)).toThrow()
    const tinyChunks = encodeHeader({ ...base, chunkSize: 16 })
    expect(() => parseHeaderBytes(tinyChunks, tinyChunks.length)).toThrow(/malformed/)
  })

  it('describes newer format versions instead of throwing', () => {
    const v2 = encodeHeader({ ...base, formatVersion: 2 })
    const parsed = parseHeaderBytes(v2, v2.length)
    expect(parsed.supported).toBe(false)
    expect(parsed.header.formatVersion).toBe(2)
    expect(parsed.header.kdf.memoryKiB).toBe(FAST_KDF_PARAMS.memoryKiB)
    expect(parsed.header.createdAt).toBe(base.createdAt)
  })
})

describe('readDevBackupHeader', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await makeTempDir()
  })
  afterEach(async () => {
    await removeTempDir(tmp)
  })

  it('maps filesystem and format problems to stable codes', async () => {
    await expectCode(readDevBackupHeader(path.join(tmp, 'missing.devbackup')), 'PATH_NOT_FOUND')
    await expectCode(readDevBackupHeader(tmp), 'ARCHIVE_INVALID')
    const garbage = path.join(tmp, 'garbage.devbackup')
    await fs.writeFile(garbage, Buffer.alloc(4096, 0x41))
    await expectCode(readDevBackupHeader(garbage), 'ARCHIVE_INVALID')
    const empty = path.join(tmp, 'empty.devbackup')
    await fs.writeFile(empty, Buffer.alloc(0))
    await expectCode(readDevBackupHeader(empty), 'ARCHIVE_INVALID')
  })

  it('reads a valid header and reports unsupported versions', async () => {
    const file = path.join(tmp, 'h.devbackup')
    await fs.writeFile(file, Buffer.concat([encodeHeader(base), Buffer.alloc(100)]))
    const result = await readDevBackupHeader(file)
    expect(result.supported).toBe(true)
    expect(result.header).toEqual(base)
    expect(result.sizeBytes).toBe(encodeHeader(base).length + 100)
    await fs.writeFile(file, encodeHeader({ ...base, formatVersion: 7 }))
    const newer = await readDevBackupHeader(file)
    expect(newer.supported).toBe(false)
    expect(newer.header.formatVersion).toBe(7)
  })
})
