/**
 * Shared fixtures for the archive tests. Everything lives under os.tmpdir(); real user data is
 * never touched. Only imported by *.test.ts files.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Header } from 'tar'
import type { Manifest } from '@devmig/model'
import { MigrationError, isPathWithin } from '@devmig/shared'
import type { ErrorCode } from '@devmig/model'
import { expect } from 'vitest'
import { writeChecksumsFile } from './checksums'
import {
  DEFAULT_CHUNK_SIZE,
  FAST_KDF_PARAMS,
  FIXED_PREFIX_LENGTH,
  GCM_TAG_LENGTH,
  SALT_LENGTH,
} from './constants'
import { createDevBackup } from './create'
import { createEncryptStream } from './crypto-stream'
import { buildHeader, encodeHeader } from './header'
import { deriveKeyFromPassword } from './kdf'
import { deriveContentKey, generateMasterKey, hashHeaderBytes, wrapMasterKey } from './keys'
import type { CreateDevBackupOptions, CreateDevBackupResult } from './types'

export const FAST_KDF = {
  memoryKiB: FAST_KDF_PARAMS.memoryKiB,
  iterations: FAST_KDF_PARAMS.iterations,
  parallelism: FAST_KDF_PARAMS.parallelism,
}
export const PASSWORD = 'correct horse battery staple'

export async function makeTempDir(prefix = 'devmig-archive-'): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const real = await fs.realpath(created)
  await fs.chmod(real, 0o700)
  return real
}

/** rm -rf restricted to the OS temp dir. */
export async function removeTempDir(dir: string): Promise<void> {
  const tmpRoot = await fs.realpath(os.tmpdir())
  let real: string
  try {
    real = await fs.realpath(dir)
  } catch {
    return
  }
  if (real === tmpRoot || !isPathWithin(tmpRoot, real)) {
    throw new Error(`Refusing to remove ${real}: outside the temp dir`)
  }
  await fs.rm(real, { recursive: true, force: true, maxRetries: 3 })
}

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    format: 'devbackup',
    formatVersion: 1,
    id: 'backup_test-0001',
    label: 'Test backup',
    createdAt: '2026-08-27T10:00:00.000Z',
    appVersion: '0.1.0-test',
    machine: {
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '15.0',
      machineLabel: 'Test Mac',
      homeDir: '/Users/tester',
      userName: 'tester',
      tools: [],
      capturedAt: '2026-08-27T10:00:00.000Z',
    },
    providers: { 'claude-code': 1, git: 1 },
    projects: [
      {
        id: 'p1',
        name: 'project-one',
        originalPath: '/Users/tester/Documents/GitHub/project-one',
        canonicalPath: '/Users/tester/Documents/GitHub/project-one',
        providers: [
          {
            providerId: 'claude-code',
            schemaVersion: 1,
            artifacts: [
              {
                id: 'p1:claude-code:sessions',
                providerId: 'claude-code',
                kind: 'directory',
                label: 'Claude Code sessions',
                payloadPath: 'projects/p1/claude-code/sessions',
                sizeBytes: 0,
                sensitivity: 'safe',
                meta: {},
              },
            ],
            summary: {},
          },
        ],
      },
    ],
    global: [],
    stats: {
      projectCount: 1,
      artifactCount: 1,
      payloadBytes: 0,
      claudeSessionCount: 0,
      worktreeCount: 0,
    },
    restoreHints: {},
    ...overrides,
  }
}

export interface StagingTree {
  root: string
  manifest: Manifest
  /** Relative POSIX path → content for every regular file written (manifest.json included). */
  files: Map<string, Buffer>
  emptyDirs: string[]
}

/** A realistic staging tree: nested dirs, an empty file, a 3 MB file, unicode names, exec bit, empty dir. */
export async function buildStagingTree(
  root: string,
  manifest = makeManifest(),
): Promise<StagingTree> {
  const files = new Map<string, Buffer>()
  const write = async (rel: string, data: Buffer | string, mode = 0o644): Promise<void> => {
    const abs = path.join(root, ...rel.split('/'))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    await fs.writeFile(abs, buf, { mode })
    files.set(rel, buf)
  }
  await write('manifest.json', JSON.stringify(manifest, null, 2))
  await write('machine.json', JSON.stringify(manifest.machine, null, 2))
  await write(
    'projects/p1/claude-code/sessions/0a1b2c3d.jsonl',
    Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        i,
        cwd: '/Users/tester/Documents/GitHub/project-one',
        text: 'hello '.repeat(20),
      }),
    ).join('\n') + '\n',
  )
  await write('projects/p1/claude-code/sessions/empty.jsonl', '')
  await write('projects/p1/git/repo.bundle', randomBytes(3 * 1024 * 1024))
  await write('projects/p1/git/untracked/Straße-ñ-日本語 файл.txt', 'unicode content\n')
  await write('projects/p1/git/hooks/pre-commit', '#!/bin/sh\nexit 0\n', 0o755)
  await write('projects/p1/project-files/.env.local', 'API_KEY=not-a-real-secret\n', 0o600)
  await write('global/claude-code/settings.json', '{"theme":"dark"}\n')
  const emptyDirs = ['projects/p1/claude-code/todos']
  for (const d of emptyDirs) await fs.mkdir(path.join(root, ...d.split('/')), { recursive: true })
  return { root, manifest, files, emptyDirs }
}

export interface FixtureBackup extends StagingTree {
  outputPath: string
  result: CreateDevBackupResult
  password: string
}

/** Builds a staging tree, writes checksums.json and creates a backup with the fast KDF preset. */
export async function createFixtureBackup(
  tmp: string,
  opts: {
    chunkSize?: number
    password?: string
    manifest?: Manifest
    mutate?: (tree: StagingTree) => Promise<void>
  } = {},
): Promise<FixtureBackup> {
  const staging = path.join(tmp, 'staging')
  await fs.mkdir(staging, { recursive: true })
  const tree = await buildStagingTree(staging, opts.manifest)
  await writeChecksumsFile(staging)
  tree.files.set('checksums.json', await fs.readFile(path.join(staging, 'checksums.json')))
  if (opts.mutate) await opts.mutate(tree)
  const outputPath = path.join(tmp, 'out', 'test.devbackup')
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const password = opts.password ?? PASSWORD
  const result = await createDevBackup({
    sourceDir: staging,
    outputPath,
    password,
    manifest: tree.manifest,
    kdf: FAST_KDF,
    chunkSize: opts.chunkSize ?? DEFAULT_CHUNK_SIZE,
  })
  return { ...tree, outputPath, result, password }
}

export function fastCreateOptions(
  base: Omit<CreateDevBackupOptions, 'kdf'>,
): CreateDevBackupOptions {
  return { ...base, kdf: FAST_KDF }
}

/** Reads every regular file under root (POSIX relative path → bytes) and lists empty directories. */
export async function readTree(
  root: string,
): Promise<{ files: Map<string, Buffer>; dirs: string[]; symlinks: string[] }> {
  const files = new Map<string, Buffer>()
  const dirs: string[] = []
  const symlinks: string[] = []
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? path.join(root, ...rel.split('/')) : root
    for (const d of await fs.readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isSymbolicLink()) symlinks.push(childRel)
      else if (d.isDirectory()) {
        dirs.push(childRel)
        await walk(childRel)
      } else if (d.isFile()) files.set(childRel, await fs.readFile(path.join(abs, d.name)))
    }
  }
  await walk('')
  return { files, dirs: dirs.sort(), symlinks }
}

export async function expectCode<T>(promise: Promise<T>, code: ErrorCode): Promise<MigrationError> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught, `expected rejection with ${code}`).toBeInstanceOf(MigrationError)
  const err = caught as MigrationError
  expect(err.code, `expected ${code} but got ${err.code}: ${err.message}`).toBe(code)
  return err
}

// ---- byte-level tampering ---------------------------------------------------------------

export interface Layout {
  payloadOffset: number
  headerJsonLength: number
  chunkSize: number
  sealedChunkSize: number
  sizeBytes: number
}

export async function readLayout(file: string): Promise<Layout> {
  const buf = await fs.readFile(file)
  const headerJsonLength = buf.readUInt32BE(8)
  const json = JSON.parse(
    buf.subarray(FIXED_PREFIX_LENGTH, FIXED_PREFIX_LENGTH + headerJsonLength).toString('utf8'),
  ) as {
    chunkSize: number
  }
  return {
    payloadOffset: FIXED_PREFIX_LENGTH + headerJsonLength,
    headerJsonLength,
    chunkSize: json.chunkSize,
    sealedChunkSize: json.chunkSize + GCM_TAG_LENGTH,
    sizeBytes: buf.length,
  }
}

export async function flipByte(file: string, offset: number): Promise<void> {
  const buf = await fs.readFile(file)
  const current = buf[offset]
  if (current === undefined) throw new Error('offset out of range')
  buf[offset] = current ^ 0x01
  await fs.writeFile(file, buf)
}

/** Replaces a byte inside the header JSON so the JSON stays syntactically valid (digit → other digit). */
export async function tamperHeaderField(file: string, field: string): Promise<void> {
  const buf = await fs.readFile(file)
  const layout = await readLayout(file)
  const json = buf.subarray(FIXED_PREFIX_LENGTH, layout.payloadOffset).toString('latin1')
  const at = json.indexOf(`"${field}":"`)
  if (at < 0) throw new Error(`field ${field} not found`)
  let i = at + field.length + 4
  while (i < json.length && !/[0-9]/.test(json[i] as string)) i += 1
  const digit = json[i] as string
  const replacement = digit === '9' ? '8' : String(Number(digit) + 1)
  buf.write(replacement, FIXED_PREFIX_LENGTH + i, 1, 'latin1')
  await fs.writeFile(file, buf)
}

export async function truncateFile(file: string, length: number): Promise<void> {
  await fs.truncate(file, length)
}

export async function swapChunks(file: string, i: number, j: number): Promise<void> {
  const buf = await fs.readFile(file)
  const layout = await readLayout(file)
  const a = layout.payloadOffset + i * layout.sealedChunkSize
  const b = layout.payloadOffset + j * layout.sealedChunkSize
  const ca = Buffer.from(buf.subarray(a, a + layout.sealedChunkSize))
  const cb = Buffer.from(buf.subarray(b, b + layout.sealedChunkSize))
  cb.copy(buf, a)
  ca.copy(buf, b)
  await fs.writeFile(file, buf)
}

export async function setFormatVersion(file: string, version: number): Promise<void> {
  const buf = await fs.readFile(file)
  buf.writeUInt16BE(version, 6)
  // keep the JSON consistent so only the version check trips
  const layout = await readLayout(file)
  const json = buf.subarray(FIXED_PREFIX_LENGTH, layout.payloadOffset).toString('utf8')
  const patched = json.replace('"formatVersion":1', `"formatVersion":${version}`)
  if (Buffer.byteLength(patched) !== layout.headerJsonLength)
    throw new Error('version patch changed length')
  buf.write(patched, FIXED_PREFIX_LENGTH, 'utf8')
  await fs.writeFile(file, buf)
}

// ---- raw tar + low-level encryption for hostile payloads --------------------------------

export interface RawTarEntry {
  path: string
  type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link' | 'FIFO' | 'CharacterDevice' | 'BlockDevice'
  body?: Buffer | string
  /** Overrides the declared size (defaults to body length). */
  size?: number
  linkpath?: string
  mode?: number
}

/** Builds an uncompressed ustar stream from arbitrary (possibly hostile) entries. */
export function buildRawTar(entries: RawTarEntry[], opts: { omitEnd?: boolean } = {}): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const body =
      e.body === undefined
        ? Buffer.alloc(0)
        : typeof e.body === 'string'
          ? Buffer.from(e.body, 'utf8')
          : e.body
    const header = new Header({
      path: e.path,
      type: e.type ?? 'File',
      size: e.size ?? body.length,
      mode: e.mode ?? (e.type === 'Directory' ? 0o755 : 0o644),
      mtime: new Date('2026-01-01T00:00:00Z'),
      ...(e.linkpath ? { linkpath: e.linkpath } : {}),
    })
    const block = Buffer.alloc(512)
    header.encode(block, 0)
    blocks.push(block)
    if (body.length > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
      body.copy(padded)
      blocks.push(padded)
    }
  }
  if (!opts.omitEnd) blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** manifest.json + checksums.json entries wrapping the given middle entries (checksums cover only the manifest). */
export function hostileTar(
  manifest: Manifest,
  middle: RawTarEntry[],
  opts: { extraChecksums?: RawTarEntry[] } = {},
): Buffer {
  const manifestBody = Buffer.from(JSON.stringify(manifest), 'utf8')
  const entries = [
    { path: 'manifest.json', body: manifestBody },
    ...(opts.extraChecksums ?? []).map((e) => e),
  ]
  const checksums = {
    algorithm: 'sha256',
    entries: [
      { path: 'manifest.json', sha256: sha256Hex(manifestBody), sizeBytes: manifestBody.length },
      ...(opts.extraChecksums ?? []).map((e) => {
        const body = typeof e.body === 'string' ? Buffer.from(e.body) : (e.body ?? Buffer.alloc(0))
        return { path: e.path, sha256: sha256Hex(body), sizeBytes: body.length }
      }),
    ].sort((a, b) => (a.path < b.path ? -1 : 1)),
  }
  return buildRawTar([
    ...entries,
    ...middle,
    { path: 'checksums.json', body: JSON.stringify(checksums) },
  ])
}

/** Encrypts an arbitrary payload with the low-level primitives into a well-formed container. */
export async function encryptRawPayload(
  outputPath: string,
  payload: Buffer | Readable,
  opts: { password?: string; backupId?: string; chunkSize?: number } = {},
): Promise<void> {
  const password = opts.password ?? PASSWORD
  const chunkSize = opts.chunkSize ?? 64 * 1024
  const salt = randomBytes(SALT_LENGTH)
  const kdf = { ...FAST_KDF_PARAMS, saltBase64: salt.toString('base64') }
  const kek = await deriveKeyFromPassword(password, kdf)
  const masterKey = generateMasterKey()
  const header = buildHeader({
    chunkSize,
    kdf,
    wrappedMasterKey: wrapMasterKey(kek, masterKey).toString('base64'),
    createdAt: new Date().toISOString(),
    backupId: opts.backupId ?? 'backup_test-0001',
    appVersion: 'test',
  })
  const headerBytes = encodeHeader(header)
  await fs.writeFile(outputPath, headerBytes)
  const source = Buffer.isBuffer(payload) ? Readable.from([payload]) : payload
  await pipeline(
    source,
    createEncryptStream({
      contentKey: deriveContentKey(masterKey, salt),
      headerHash: hashHeaderBytes(headerBytes),
      chunkSize,
    }),
    createWriteStream(outputPath, { flags: 'a' }),
  )
}
