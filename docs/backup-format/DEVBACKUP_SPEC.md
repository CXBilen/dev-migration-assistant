# `.devbackup` container format — version 1

Normative specification of the encrypted backup file written and read by `@devmig/archive`
(`packages/archive`). Design rationale: [ADR-0003](../architecture/adr/0003-devbackup-container.md)
and [docs/research/archive-crypto.md](../research/archive-crypto.md). Threats:
[docs/security/THREAT_MODEL.md](../security/THREAT_MODEL.md).

The words MUST / MUST NOT / SHOULD are used in the RFC 2119 sense. "Reader" means any
implementation that opens a `.devbackup`; "writer" means any implementation that produces one.

## 1. Goals

| Goal                                         | How the format achieves it                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Confidential at rest                         | Everything except a small parameter header is AES-256-GCM encrypted under a random per-file key.       |
| Password protected, offline-attack resistant | Password → KEK with Argon2id (memory-hard); only the KEK-wrapped master key is stored.                 |
| Tamper evident, early failure                | Payload split into fixed-size AEAD chunks (STREAM construction); the first bad chunk stops the reader. |
| Streamable in both directions                | Writer and reader never hold more than a couple of chunks in memory; tens of GiB are fine.             |
| Truncation / reorder / transplant proof      | Chunk counter and last-chunk flag in the nonce; header hash in every chunk's AAD.                      |
| Inspectable with standard tools              | After decryption the payload is a plain, uncompressed POSIX/ustar tar.                                 |
| Untrusted input on restore                   | Manifest validated first, strict entry rules, hard limits, per-file checksums, fail closed.            |
| Portable between Macs                        | No uid/gid/uname/gname, POSIX paths, UTF-8, NFC-normalised password.                                   |

## 2. Byte layout

All integers are big-endian. `L` is the header JSON length in bytes.

| Offset | Size | Field              | Value / rule                                                                                           |
| ------ | ---- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| 0      | 6    | `magic`            | ASCII `DEVBKP` = `44 45 56 42 4B 50`. Anything else → `ARCHIVE_INVALID`.                               |
| 6      | 2    | `formatVersion`    | u16 = `0x0001` for this document. `0` → `ARCHIVE_INVALID`; `> 1` → `ARCHIVE_UNSUPPORTED_VERSION` (§9). |
| 8      | 4    | `headerJsonLength` | u32 `L`. Readers MUST reject `L < 2` or `L > 65536` before allocating anything.                        |
| 12     | `L`  | `headerJson`       | UTF-8 JSON, no BOM, no trailing newline, produced by `JSON.stringify` with the key order of §3.        |
| 12+`L` | …    | payload chunks     | Sealed AES-256-GCM chunks (§5), back to back. Nothing may follow the final chunk.                      |

"The header bytes" `H` = bytes `[0, 12 + L)` — magic, version, length and JSON. `SHA-256(H)` is the
first 32 bytes of every chunk's AAD, so any header modification breaks every chunk.

A file shorter than 12 bytes, or whose `L` extends past end-of-file, is `ARCHIVE_INVALID`.

## 3. Header JSON

The header is plaintext and contains nothing sensitive beyond the KDF parameters and the
wrapped key. Labels, machine names and the manifest live inside the encrypted payload.

Keys MUST be written in exactly this order (readers ignore unknown extra keys within v1):

```json
{
  "magic": "DEVBKP",
  "formatVersion": 1,
  "cipher": "aes-256-gcm",
  "chunkSize": 1048576,
  "kdf": {
    "algorithm": "argon2id",
    "memoryKiB": 65536,
    "iterations": 3,
    "parallelism": 4,
    "saltBase64": "<base64, 16 bytes>"
  },
  "wrappedMasterKey": "<base64, 60 bytes: nonce(12) || ciphertext(32) || tag(16)>",
  "createdAt": "2026-08-27T10:00:00.000Z",
  "backupId": "backup_…",
  "appVersion": "0.1.0"
}
```

Reader validation, performed before any cryptography (`ARCHIVE_INVALID` on failure):

| Field              | Rule                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| `magic`            | `"DEVBKP"`                                                                |
| `formatVersion`    | positive integer, equal to the binary field at offset 6                   |
| `cipher`           | `"aes-256-gcm"`                                                           |
| `chunkSize`        | integer, `4096 ≤ chunkSize ≤ 16777216` (writers default to 1 MiB)         |
| `kdf.algorithm`    | `"argon2id"`                                                              |
| `kdf.memoryKiB`    | integer, `8192 ≤ m ≤ 1048576` and `m ≥ 8 × parallelism`                   |
| `kdf.iterations`   | integer, `1 ≤ t ≤ 16`                                                     |
| `kdf.parallelism`  | integer, `1 ≤ p ≤ 16`                                                     |
| `kdf.saltBase64`   | strict base64 decoding to 8–64 bytes (writers use 16)                     |
| `wrappedMasterKey` | strict base64 decoding to exactly 60 bytes                                |
| `createdAt`        | non-empty string ≤ 64 chars (ISO-8601 by convention; not interpreted)     |
| `backupId`         | non-empty string ≤ 256 chars; MUST equal `manifest.id` inside the payload |
| `appVersion`       | string ≤ 64 chars                                                         |

The bounds on `kdf.*` and `chunkSize` exist because a hostile header could otherwise ask a reader to
allocate gigabytes before the password is even checked.

## 4. Keys and KDF

```text
password  ──NFC normalise──▶ UTF-8 bytes
            │
            ▼  Argon2id(salt, m, t, p, tagLength = 32)                     [hash-wasm, WASM]
           KEK (32 B)
            │
            ▼  AES-256-GCM(key = KEK, nonce = random 12 B, aad = "devbackup-kek-v1")
wrappedMasterKey = nonce ‖ ciphertext(32) ‖ tag(16)        ◀── masterKey = 32 random bytes
                                                                  │
                                                                  ▼  HKDF-SHA-256(ikm = masterKey, salt = kdf salt, info = "devbackup/content/v1", 32)
                                                            contentKey (32 B)  — encrypts the payload chunks
headerHash = SHA-256(header bytes H)
```

- **KDF parameters.** Writers default to `m = 65536 KiB (64 MiB), t = 3, p = 4` (RFC 9106 "second
  recommended" option; ≈0.1 s on Apple Silicon, ≈0.5 s on older Intel Macs). A `fast` preset
  `m = 8192, t = 1, p = 1` exists **for tests only** and is exactly the reader floor. Readers accept
  any parameters within the bounds of §3; the floor prevents a downgraded header from making
  offline guessing cheap, the caps prevent denial of service.
- **Salt.** 16 fresh random bytes per file. Two backups made with the same password are unrelated.
- **Password normalisation.** The password is Unicode-NFC-normalised before hashing so that the same
  characters typed on two Macs (which may produce composed or decomposed forms) derive the same key.
  Empty passwords are rejected (`INVALID_INPUT`); the app enforces a minimum length at its boundary.
- **Master-key wrap.** The GCM tag of the wrap doubles as the password check. A wrong password and a
  modified `kdf`/`wrappedMasterKey` field are indistinguishable by design: both surface as
  `ARCHIVE_AUTH_FAILED` **before a single payload byte is read**.
- **Content key.** Derived, never stored. The master key and KEK are zeroed as soon as the content
  key exists; the content key is zeroed when the operation ends.

## 5. Payload chunk encryption

The plaintext payload `P` (the tar stream of §7) is split into chunks of exactly `chunkSize` bytes;
the last chunk holds the remaining `0 … chunkSize` bytes. Each chunk `i` (from 0) is sealed with
AES-256-GCM (16-byte tag):

```text
nonce(i, last) = BE88(i) ‖ (last ? 0x01 : 0x00)          // 12 bytes: 11-byte counter, 1-byte flag
aad(i)         = headerHash(32) ‖ BE64(i)                 // 40 bytes
sealed_i       = AES-256-GCM-Encrypt(contentKey, nonce(i, last_i), plaintext_i, aad(i)) ‖ tag_i
```

Writer:

```text
buf = ∅; i = 0
for each plaintext piece from the tar stream:
    buf ‖= piece
    while len(buf) > chunkSize:                  # strictly greater: keep ≥ 1 byte for the final chunk
        emit seal(i, last=false, buf[0:chunkSize]); buf = buf[chunkSize:]; i += 1
at end of stream:
    emit seal(i, last=true, buf)                 # may be shorter than chunkSize (empty only if P is empty)
```

Reader (seekable file; `C` = ciphertext length = fileSize − (12 + L), `S = chunkSize + 16`):

```text
i = 0; consumed = 0
loop:
    remaining = C − consumed
    if remaining ≤ S:  ct = read(remaining); last = true      # final chunk, any length 16 … S
    else:              ct = read(S);         last = false
    if len(ct) < 16: fail INTEGRITY_MISMATCH
    pt = AES-256-GCM-Decrypt(contentKey, nonce(i, last), ct, aad(i))   # tag failure → INTEGRITY_MISMATCH
    release pt only now; consumed += len(ct); i += 1
    if last: stop (EOF must follow; a longer-than-declared file is INTEGRITY_MISMATCH)
if EOF is reached without a successful final chunk: fail INTEGRITY_MISMATCH
```

A non-seekable reader keeps one chunk of lookahead: every buffered run longer than `S` releases a
non-final chunk; at EOF the remainder is opened as the final chunk.

Plaintext is released **only after** the tag verified. Node's GCM emits unauthenticated bytes
from `update()` before `final()` fails; the implementation buffers each chunk's output and drops
it on failure, so nothing unauthenticated ever reaches the tar parser or the disk.

Nonce uniqueness: the content key is unique per file (random master key + random salt), and the
counter is deterministic, so no (key, nonce) pair repeats. Chunking also keeps every GCM invocation
far below the 2^39 − 256 bit single-message limit.

## 6. Failure modes and what detects them

| Mutation of the file                                | Detected by                                          | Error code                                                              |
| --------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Not a `.devbackup`, bad magic, < 12 bytes           | magic / length checks                                | `ARCHIVE_INVALID`                                                       |
| Header JSON syntactically broken, out-of-bounds     | JSON parse + schema                                  | `ARCHIVE_INVALID`                                                       |
| Newer `formatVersion`                               | version check (header still readable)                | `ARCHIVE_UNSUPPORTED_VERSION`                                           |
| Wrong password                                      | master-key wrap tag                                  | `ARCHIVE_AUTH_FAILED`                                                   |
| `kdf.*` or `wrappedMasterKey` modified              | master-key wrap tag (different KEK / ciphertext)     | `ARCHIVE_AUTH_FAILED`                                                   |
| Any other header byte modified (e.g. `createdAt`)   | chunk 0 AAD (`SHA-256(H)`)                           | `INTEGRITY_MISMATCH` (chunk 0)                                          |
| Payload byte flipped                                | that chunk's GCM tag                                 | `INTEGRITY_MISMATCH` (chunk i)                                          |
| Chunks swapped, dropped, duplicated                 | counter in nonce and AAD                             | `INTEGRITY_MISMATCH`                                                    |
| Truncated at a chunk boundary                       | last present chunk sealed with `last=0`, opened as 1 | `INTEGRITY_MISMATCH`                                                    |
| Truncated mid-chunk                                 | wrong length / tag                                   | `INTEGRITY_MISMATCH`                                                    |
| Truncated to header only                            | EOF before final chunk                               | `INTEGRITY_MISMATCH`                                                    |
| Bytes appended                                      | boundary shift → tag failure                         | `INTEGRITY_MISMATCH`                                                    |
| Payload transplanted under another header           | AAD binds `SHA-256(H)`                               | `INTEGRITY_MISMATCH`                                                    |
| Plaintext file modified before packing (stale sums) | `checksums.json` comparison                          | `INTEGRITY_MISMATCH`                                                    |
| Tar entry rules violated (§7.3)                     | entry guard                                          | `ARCHIVE_ENTRY_REJECTED` / `ARCHIVE_INVALID` / `ARCHIVE_LIMIT_EXCEEDED` |
| Manifest missing / malformed / mismatched id        | manifest validation                                  | `MANIFEST_INVALID` / `ARCHIVE_INVALID`                                  |
| Cancelled by the user                               | `AbortSignal`                                        | `CANCELLED` (partial output removed)                                    |

## 7. Payload: tar rules

### 7.1 Format

- Uncompressed POSIX/ustar tar as written by node-tar v7 with `portable: true` (PAX extended
  headers are used only when a field does not fit — long or non-ASCII paths, large sizes).
- No `uid`, `gid`, `uname`, `gname`, `dev`, `ino`, `nlink`, `atime` or `ctime`. `mtime` and the
  permission bits are preserved (`portable` mode clears group/other write bits and guarantees
  owner read/write).
- Only **regular files** and **directories** are written. Symlinks, hardlinks, sockets, FIFOs and
  devices in the source tree are skipped (reported as warnings). Repeated inodes are never turned
  into hardlink entries.
- Compression is **not** used in v1 (see §9 for the v2 idea). A reader MUST treat a compressed
  payload as `ARCHIVE_INVALID`; in particular it MUST NOT let its tar library auto-detect gzip.

### 7.2 Entry order (deterministic)

1. `manifest.json` — the first entry, always a regular file, always a plain ustar header (no PAX
   entry precedes it). Readers MUST verify the first 512-byte block is that header before parsing.
2. Every other file and directory of the payload root, sorted by the **UTF-8 byte sequence** of the
   POSIX relative path (so a directory always precedes its contents).
3. `checksums.json` — the last entry. Nothing may follow it.

Directory entries carry a trailing `/` in the tar header (node-tar convention) and size 0.

### 7.3 Reader entry rules (applied before anything is written; "entry guard")

An entry is rejected — and the whole operation fails, with the destination emptied again — when:

| Rule                                                                                                                                    | Code                                         |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Type is not `File` or `Directory` (links, devices, FIFOs, sparse, GNU dump dirs, …)                                                     | `ARCHIVE_ENTRY_REJECTED`                     |
| Path is empty, absolute, has a drive prefix (`C:`), a `\`, a NUL, an empty / `.` / `..` segment                                         | `ARCHIVE_ENTRY_REJECTED`                     |
| Path segment ends with the reserved suffix `.devmig-partial`                                                                            | `ARCHIVE_ENTRY_REJECTED`                     |
| Duplicate path, case-/normalisation-insensitive duplicate, or a path through an earlier file                                            | `ARCHIVE_ENTRY_REJECTED`                     |
| Directory entry with a body, negative or non-integer size                                                                               | `ARCHIVE_ENTRY_REJECTED`                     |
| Path longer than `maxPathLength` bytes (default 1024) or deeper than `maxDepth` (default 128)                                           | `ARCHIVE_LIMIT_EXCEEDED`                     |
| More than `maxEntries` entries (default 2 000 000)                                                                                      | `ARCHIVE_LIMIT_EXCEEDED`                     |
| Entry larger than `maxEntryBytes` (default 50 GiB) or cumulative size over `maxTotalBytes` (200 GiB)                                    | `ARCHIVE_LIMIT_EXCEEDED`                     |
| `manifest.json` larger than 64 MiB, `checksums.json` larger than 256 MiB                                                                | `ARCHIVE_LIMIT_EXCEEDED`                     |
| First entry is not the file `manifest.json`; a second `manifest.json`; any entry after `checksums.json`; no `checksums.json` at the end | `ARCHIVE_INVALID` / `ARCHIVE_ENTRY_REJECTED` |
| Tar structurally broken (bad header checksum, truncated body, missing end blocks)                                                       | `ARCHIVE_INVALID`                            |

Additional reader guarantees:

- `manifest.json` is fully read, parsed and validated against the zod `Manifest` schema
  (`MANIFEST_INVALID`) **before the parser sees the next entry**. `manifest.formatVersion` MUST equal
  the container version and `manifest.id` MUST equal the header's `backupId` (`ARCHIVE_INVALID`).
- Extraction targets an **empty directory only** (created with mode 0700 when missing; a non-empty
  directory is `RESTORE_DESTINATION_EXISTS`, a file `NOT_A_DIRECTORY`, a symlink `INVALID_INPUT`).
- Files are written to `<name>.devmig-partial` in the target directory, fsynced, then renamed.
  Permission bits come from the archive (`& 0o777`, owner read/write forced); `mtime` is restored.
- After extraction every path is `lstat`ed (no symlink may exist) and `realpath`ed (must stay
  inside the destination).
- `checksums.json` is then verified: each listed file must exist with the same size and SHA-256
  (`INTEGRITY_MISMATCH`), and no unlisted file may exist (`ARCHIVE_INVALID`).
- **Verify** does the same checks without writing: it hashes every entry in the stream and compares
  the set with `checksums.json`.
- **Inspect** decrypts only until `manifest.json` has been read and stops; it never extracts.

### 7.4 Logical layout of the payload root

```text
manifest.json                       first entry; zod `Manifest` (packages/model/src/manifest.ts)
machine.json                        `MachineInfo`: platform, arch, tool versions — informational
projects/<projectId>/<providerId>/…  provider-owned artifacts for one selected project
global/<providerId>/…                user-wide ("global") provider artifacts
checksums.json                      last entry; zod `Checksums`
```

`ManifestArtifact.payloadPath` values are POSIX paths relative to this root (for example
`projects/p1/claude-code/sessions`). The layout under a provider directory is that provider's
business and is versioned by `manifest.providers[providerId]` (its `schemaVersion`).

### 7.5 `checksums.json`

```json
{
  "algorithm": "sha256",
  "entries": [{ "path": "manifest.json", "sha256": "<64 hex>", "sizeBytes": 1234 }]
}
```

- Lists every regular file of the payload root **except itself**, sorted by UTF-8 byte order of
  `path`. Directories are not listed. Symlinks are never packed and therefore never listed.
- `path` must be a safe relative POSIX path (same rules as §7.3); duplicates are invalid.
- The writer computes it after all providers have finished and just before packing.

## 8. Writer procedure (atomic output)

1. Validate inputs: `manifest.json` exists at the source root and its `id` matches the manifest
   given by the engine; `checksums.json` is reused when present and valid, otherwise computed.
2. Walk the source tree (sorted, links skipped), derive KEK → wrap master key → build header.
3. Create `<outputPath>.partial` with `O_EXCL` and mode 0600; write the header bytes.
4. Stream `tar → chunk encryptor → file`; report progress (bytes, entries).
5. `fsync` the file, `rename` it to `<outputPath>` (atomic on the same volume), `fsync` the directory.
6. On any error or cancellation remove the `.partial` file. The final path is never left half-written.
7. The engine re-opens the finished file and runs **verify** before reporting success.

## 9. Versioning and compatibility policy

- `formatVersion` (binary field and JSON field, which MUST agree) versions the **container**:
  layout, KDF/cipher construction, chunk rules. A reader MUST refuse any version newer than the
  one it implements with `ARCHIVE_UNSUPPORTED_VERSION`; `readDevBackupHeader` still returns the
  parsable header fields with `supported: false` so the UI can say "made with a newer version".
- Additive JSON keys within version 1 are permitted; readers ignore unknown keys. Changing the
  meaning of an existing key, the key hierarchy, the AAD, the nonce layout or the chunk rules
  requires a new `formatVersion`.
- `manifest.formatVersion` MUST equal the container version in v1.
- Provider payload layouts are versioned independently through `manifest.providers[providerId]`
  (`schemaVersion`). A provider may refuse or downgrade an unknown schema version; the container
  is not affected.
- Deliberately **not** in v1 (candidates for v2): payload compression (`payload.compression`, gzip
  or zstd inside the encryption with a decompressed-byte cap), a keyfile / Keychain-bound Argon2
  secret, multiple recipients, and per-entry random access.

## 10. Inspecting a backup manually

There is no third-party tool that reads `.devbackup`, but decryption is a few lines with Node:

```js
// decrypt.mjs — usage: node decrypt.mjs backup.devbackup password > payload.tar
import { createReadStream, readFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import {
  deriveKeyFromPassword,
  unwrapMasterKey,
  deriveContentKey,
  hashHeaderBytes,
  createDecryptStream,
  parseHeaderBytes,
} from '@devmig/archive'

const [file, password] = process.argv.slice(2)
const bytes = readFileSync(file)
const { header, headerBytes, payloadOffset } = parseHeaderBytes(bytes, bytes.length)
const kek = await deriveKeyFromPassword(password, header.kdf)
const masterKey = unwrapMasterKey(kek, Buffer.from(header.wrappedMasterKey, 'base64'))
const contentKey = deriveContentKey(masterKey, Buffer.from(header.kdf.saltBase64, 'base64'))
await pipeline(
  createReadStream(file, { start: payloadOffset }),
  createDecryptStream({
    contentKey,
    headerHash: hashHeaderBytes(headerBytes),
    chunkSize: header.chunkSize,
    totalCiphertextBytes: bytes.length - payloadOffset,
  }),
  process.stdout,
)
```

Then use ordinary tools on the plaintext tar:

```sh
tar -tvf payload.tar                       # list entries (manifest.json first, checksums.json last)
tar -xOf payload.tar manifest.json | jq .  # read the manifest
tar -xOf payload.tar checksums.json | jq '.entries | length'
mkdir out && tar -xf payload.tar -C out    # extract (trusted input only!)
( cd out && jq -r '.entries[] | "\(.sha256)  \(.path)"' checksums.json | shasum -a 256 -c )
```

`tar -x` from a shell does **not** apply the §7.3 hardening; use it only on backups you created
yourself. The app's `extractDevBackup` is the hardened path.

Header fields (KDF cost, chunk size, creation time, app version, backup id) can be read without the
password: `readDevBackupHeader(path)` or `head -c 4096 backup.devbackup | tail -c +13 | jq .` (works
when the JSON is shorter than 4084 bytes; otherwise read `L` from bytes 8–11).
