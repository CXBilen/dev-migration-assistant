# `.devbackup` container: encryption, framing and safe extraction

Design references for the encrypted, streamable `.devbackup` container used by Dev Migration Assistant.
Researched 2026-08-27 against official sources (fetched via r.jina.ai) and verified with small Node.js
prototypes on this machine (Apple M4, Node v22.22.3, `tar@7.5.22`, `hash-wasm@4.12.0`). Paths are
sanitized (`<user>`). Nothing here is secret.

## 0. Decisions at a glance

| Topic | Decision | Why (short) |
| --- | --- | --- |
| Password KDF | Argon2id (v1.3 / 0x13) via `hash-wasm`, salt 16 B random, 32 B output | RFC 9106 + OWASP recommend Argon2id; hash-wasm is the fastest pure-WASM impl and needs no native build in Electron |
| KDF params (default) | **m = 262144 KiB (256 MiB), t = 3, p = 4** (stored in header) | 0.45 s on M4; 4x RFC 9106 "second recommended" memory. Floor accepted on read: m >= 65536 KiB, t >= 3 (RFC 9106 option 2). Caps on read: m <= 1 GiB, t <= 16, p <= 16 |
| Key hierarchy | KEK = Argon2id(pw) -> unwraps random 32 B master key (AES-256-GCM, tag = password check) -> HKDF-SHA-256 subkeys | age v1 pattern: password never touches payload; wrap tag doubles as "wrong password" detector |
| Payload AEAD | AES-256-GCM, 12 B nonce = 11 B BE counter || 1 B last-flag, 16 B tag, fixed 64 KiB plaintext chunks, AAD = SHA-256(full header) | age/STREAM construction: truncation, reorder, drop, swap and header-transplant all fail authentication; no 64 GiB GCM single-message limit |
| Header integrity | HMAC-SHA-256 over magic..JSON with HKDF-derived header key, and every chunk's AAD binds the header | Detects edits to non-KDF fields (chunkSize, payloadNonce, createdAt, ...) |
| Inner format | tar (node-tar v7 `Pack`/`Unpack`), optional gzip inside the encryption | Streams; hardened extractor; but links and devices are still filtered out by us |
| Writing | `fs.mkdtemp` (0700) -> write `<name>.part` with `flags:'wx', mode:0o600, flush:true` -> `fs.rename` over final path | Atomic replace, no half-written archives, no world-readable temp |
| Cancellation | `stream/promises.pipeline(..., { signal })` -> AbortError `ABORT_ERR`; `finally` removes temp dir with `rm({recursive:true, force:true})` | Verified |

## 1. Sources

- hash-wasm README and API: https://github.com/Daninet/hash-wasm
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- RFC 9106 (Argon2), section 4 "Parameter Choice", 7.4 "Recommendations": https://www.rfc-editor.org/rfc/rfc9106.html
- Node.js `crypto` (createCipheriv / setAAD / getAuthTag / setAuthTag / hkdfSync / timingSafeEqual): https://nodejs.org/api/crypto.html
- Node.js `stream` (`pipeline` with `signal`): https://nodejs.org/api/stream.html
- Node.js `fs` (`mkdtemp`, `createWriteStream` `flush`, `fsync`, `rename`, `rm`): https://nodejs.org/api/fs.html
- NIST SP 800-38D (GCM), sections 5.2.1.1 and 8.3: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf
- age v1 format spec (header MAC, scrypt stanza, STREAM payload): https://age-encryption.org/v1
- STREAM paper (Hoang, Reyhanitabar, Rogaway, Vizar 2015): https://eprint.iacr.org/2015/189
- libsodium secretstream: https://doc.libsodium.org/secret-key_cryptography/secretstream
- node-tar README (v7): https://github.com/isaacs/node-tar
- node-tar advisories: https://github.com/isaacs/node-tar/security/advisories and the GHSA pages cited in section 7.4

## 2. Password KDF: Argon2id with hash-wasm

### 2.1 API (verified against `hash-wasm@4.12.0` `dist/lib/argon2.d.ts` and README)

```ts
import { argon2id } from 'hash-wasm'

interface IArgon2Options {
  password: IDataType        // string | Buffer | Uint8Array | Uint16Array | Uint32Array
  salt: IDataType            // README: "salt is a buffer containing random bytes"; impl throws if < 8 bytes
  secret?: IDataType         // optional keyed hashing (Argon2 "secret"/pepper) - we do not use it
  iterations: number         // t (time cost)
  parallelism: number        // p (lanes)
  memorySize: number         // m, in KiB ("amount of memory to be used in kibibytes (1024 bytes)")
  hashLength: number         // output bytes (>= 4)
  outputType?: 'hex' | 'binary' | 'encoded'   // 'binary' -> Uint8Array (typed: Argon2ReturnType<T>)
}
argon2id(options): Promise<string | Uint8Array>
```

Source: https://github.com/Daninet/hash-wasm#api (the `IArgon2Options` block) and the README example under
"Hashing passwords with Argon2", which itself points at the IETF Argon2 draft for parameter choice.

Facts checked in the installed package:

- Runtime validation (`dist/index.esm.js`): `"Salt should be at least 8 bytes long"`, `"Iterations should be a positive number"`,
  `"Parallelism should be a positive number"`, `"Hash length should be at least 4 bytes."`, `"Memory size should be at least 8 * parallelism."`.
- `outputType: 'binary'` returns a `Uint8Array` (verified: `Uint8Array len=32`).
- Strings are UTF-8 encoded; README section "String encoding pitfalls" warns that `"\u00fc"` and `"u\u0308"` are different byte
  sequences for the same visible character (`"\u00fc" === "u\u0308"; // false`). **Normalize the password with `password.normalize('NFC')` before hashing**
  (macOS text input can produce decomposed forms; otherwise the same typed password could fail on the other Mac).
- The Argon2 WASM is **single-threaded** (README "Future plans": "Enable multithreading where it's possible (like at Argon2)").
  `parallelism` therefore does not speed up derivation for us; it only fixes the lane structure that an attacker could parallelise.
- **The Promise API still blocks the calling thread.** Measured: during a 400-900 ms `argon2id()` call, a 10 ms `setInterval`
  on the same thread fired **0** times. Running the same call in a `worker_threads` Worker kept the main loop ticking
  (41-43 ticks during a 450-480 ms derivation). => Run the KDF in a Worker (or Electron `utilityProcess`) so IPC/progress
  events and cancellation keep working. WASM memory is not returned to the OS after the call (RSS stayed at 1079 MiB
  after a 1 GiB test in-process); terminating the worker frees it.

### 2.2 Recommendations from the standards

- RFC 9106 section 4: "FIRST RECOMMENDED option": Argon2id t=1, p=4, m=2^21 (2 GiB), 128-bit salt, 256-bit tag.
  "If much less memory is available ... Argon2id with t=3 iterations, p=4 lanes, m=2^16 (64 MiB of RAM), 128-bit salt,
  and 256-bit tag size. This is the SECOND RECOMMENDED option." Procedure: choose Argon2id, "Select p=4 lanes", then pick the
  largest m and time the application can afford; "16 bytes is RECOMMENDED for password hashing" salt (section 3.1).
  https://www.rfc-editor.org/rfc/rfc9106.html#section-4
- RFC 9106 section 7.3/7.4: for Argon2id "1 pass maximizes the attack costs for the constant defender time"; i.e. for a fixed
  time budget prefer more memory over more passes.
- OWASP (server login context, so a *minimum*): "Use Argon2id with a minimum configuration of 19 MiB of memory, an iteration
  count of 2, and 1 degree of parallelism"; equivalent-cost alternatives listed: m=47104 (46 MiB) t=1 p=1; m=19456 t=2 p=1;
  m=12288 t=3 p=1; m=9216 t=4 p=1; m=7168 t=5 p=1. https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#argon2id
- age v1 (a comparable "password-protected file" design) uses scrypt for its passphrase stanza and says the reader "SHOULD apply an
  upper limit to the work factor" and "MUST check that the body length is exactly 32 bytes before attempting to decrypt it, to
  mitigate partitioning oracle attacks". https://age-encryption.org/v1#scrypt-recipient-stanza

### 2.3 Measured cost on this machine (hash-wasm 4.12.0, Node 22.22.3, Apple M4, single thread)

| Parameters | Time | Notes |
| --- | --- | --- |
| m=19 MiB t=2 p=1 (OWASP minimum) | 19-24 ms | server-login floor, too cheap for an offline-attackable file |
| m=46 MiB t=1 p=1 (OWASP alt.) | 25 ms | |
| m=64 MiB t=3 p=1 | ~100 ms | |
| m=64 MiB t=3 p=4 (RFC 9106 option 2) | ~105 ms | p does not change our cost (single-threaded WASM) |
| m=128 MiB t=3 p=4 | ~218 ms | |
| m=128 MiB t=6 p=4 | ~414 ms | |
| **m=256 MiB t=3 p=4** | **~420-480 ms** | chosen default |
| m=256 MiB t=4 p=4 | ~577 ms | |
| m=512 MiB t=2 p=4 | ~585 ms | |
| m=512 MiB t=3 p=4 | ~879 ms | |
| m=1 GiB t=1 p=4 | ~659 ms | RFC option-1 shape at half memory |

### 2.4 Chosen parameters and justification

- **Default when writing: `{ algorithm: 'argon2id', version: 19, memoryKiB: 262144, iterations: 3, parallelism: 4, hashLength: 32, salt: 16 random bytes }`.**
  - 0.45 s on an M4; an older Intel Mac is roughly 2-4x slower, i.e. ~1-2 s, still acceptable for an operation that happens once
    per backup/restore (not per login). This sits in the requested 0.5-1 s interactive budget across the fleet.
  - 256 MiB is 4x the memory of RFC 9106's "much less memory" option and 13x OWASP's minimum; a stolen `.devbackup` is an
    *offline* target, so the server-oriented minimums are inappropriate. Memory, not passes, is what hurts GPU/ASIC attackers
    (RFC 9106 section 7.3), so we spend the budget on m with t=3 to keep the RFC option-2 pass count.
  - p=4 follows RFC 9106 step 4 ("Select p=4 lanes") and keeps the option open to use a multithreaded implementation later
    without changing stored parameters. It costs nothing today.
  - 256 MiB of WASM memory inside a worker is fine on every supported Mac (8 GB+). If a machine cannot allocate it the writer
    should fall back to m=64 MiB t=3 p=4 (RFC option 2) and record that in the header; never below.
- **When reading, the parameters come from the header**, so the reader MUST bound them before running the KDF
  (a hostile header could otherwise request 4 GiB and t=1000 as a DoS): accept `algorithm === 'argon2id'`,
  `8 <= salt.length <= 64`, `65536 <= memoryKiB <= 1048576`, `1 <= iterations <= 16`, `1 <= parallelism <= 16`,
  `hashLength === 32`. Reject otherwise with `ARCHIVE_INVALID`.
- `hashLength: 32` gives a 256-bit KEK for AES-256-GCM. Use `outputType: 'binary'` and wrap it with `Buffer.from(...)`.

## 3. Key hierarchy

```
password (NFC-normalized UTF-8)
  |  Argon2id(salt16, m, t, p) -> 32 bytes
  v
KEK ------ AES-256-GCM(key=KEK, nonce=12x0x00, aad="DEVBKP"||u16 version) ------> wrappedKey = ct(32) || tag(16)   [in header JSON]
                                    ^
masterKey = 32 random bytes --------+
  |
  |-- HKDF-SHA-256(ikm=masterKey, salt=empty,        info="devbkp/v1/header-mac") -> headerMacKey (32 B)
  |-- HKDF-SHA-256(ikm=masterKey, salt=payloadNonce, info="devbkp/v1/payload")    -> contentKey   (32 B)
```

- A fixed all-zero wrap nonce is safe because the KEK is unique per file (fresh 16-byte salt per file). age does exactly this
  for its scrypt stanza: "the ChaCha20-Poly1305 nonce is fixed as 12 0x00 bytes" and "A new salt MUST be generated for each
  stanza and each file". https://age-encryption.org/v1#scrypt-recipient-stanza
- HKDF: `crypto.hkdfSync(digest, ikm, salt, info, keylen)` returns an **`ArrayBuffer`** (verified), so wrap with `Buffer.from()`.
  `info` may be up to 1024 bytes; `keylen` up to 255 x digest size. https://nodejs.org/api/crypto.html#cryptohkdfsyncdigest-ikm-salt-info-keylen
- Deriving the header-MAC key and the content key from the master key mirrors age: "HMAC key = HKDF-SHA-256(ikm = file key,
  salt = empty, info = "header")" and "payload key = HKDF-SHA-256(ikm = file key, salt = nonce, info = "payload")".
  https://age-encryption.org/v1#header-mac and https://age-encryption.org/v1#payload
- The wrap's GCM tag is the **wrong-password detector**: a wrong KEK makes `decipher.final()` throw
  (`Unsupported state or unable to authenticate data`); map to `ARCHIVE_AUTH_FAILED` with the hint "Wrong password, or the
  file header was modified" (the two are indistinguishable by design; see 6.2).

## 4. Container byte layout (`.devbackup` v1)

All integers big-endian. `L` = header JSON length.

| Offset | Size | Field | Value / rule |
| --- | --- | --- | --- |
| 0 | 6 | magic | ASCII `DEVBKP` = `44 45 56 42 4B 50` |
| 6 | 2 | formatVersion | u16 = `0x0001` |
| 8 | 4 | headerLength `L` | u32; reader rejects `L > 65536` before allocating |
| 12 | L | header JSON | UTF-8, no BOM, no trailing newline, produced by `JSON.stringify` (schema in section 4.1). Plaintext, no secrets. |
| 12+L | 32 | headerMac | HMAC-SHA-256(headerMacKey, bytes[0, 12+L)) |
| 44+L | ... | payload chunks | `ceil(P / 65536)` chunks; chunk i is `ct_i || tag_i` (16 B tag); all but the last have exactly 65536+16 bytes; the last has 1..65536 plaintext bytes, i.e. 17..65552 bytes; **nothing may follow the last chunk** |

"The header" (for AAD purposes) = bytes `[0, 44+L)`, i.e. including the MAC. `H = 44 + L` is the payload offset.

### 4.1 Header JSON

Aligned with `BackupHeaderInfo` in `packages/model/src/backup.ts` (`formatVersion`, `kdf.{algorithm,memoryKiB,iterations,parallelism}`,
`cipher`, `createdAt`). All fields are visible without the password; the manifest/label live inside the encrypted tar.

```json
{
  "format": "devbackup",
  "formatVersion": 1,
  "createdAt": "2026-08-27T10:00:00.000Z",
  "appVersion": "0.1.0",
  "kdf": { "algorithm": "argon2id", "version": 19, "salt": "<base64 16 B>",
           "memoryKiB": 262144, "iterations": 3, "parallelism": 4, "hashLength": 32 },
  "wrap": { "algorithm": "aes-256-gcm", "wrappedKey": "<base64 48 B: ct32||tag16>" },
  "cipher": { "algorithm": "aes-256-gcm", "chunkSize": 65536, "payloadNonce": "<base64 16 B>" },
  "payload": { "format": "tar", "compression": "none" }
}
```

Reader validation before any crypto: exact `format`/`formatVersion`; `kdf` bounds from 2.4; `wrappedKey` decodes to exactly 48 bytes
(age's "MUST check that the body length is exactly 32 bytes before attempting to decrypt" applied to our 32+16 layout);
`chunkSize` in `[4096, 1048576]` (we always write 65536; the field exists so a future version can change it);
`payloadNonce` exactly 16 bytes; `compression` in `{"none","gzip"}`. Anything else -> `ARCHIVE_INVALID`
(unknown `formatVersion` -> `ARCHIVE_UNSUPPORTED_VERSION`).

## 5. Chunk encryption (STREAM construction, age style)

Why this construction (rather than one `createCipheriv('aes-256-gcm')` over the whole tar):

- **GCM single-message limit**: NIST SP 800-38D 5.2.1.1 requires `len(P) <= 2^39 - 256` bits per invocation (~64 GiB); a multi-repo
  backup with node_modules-sized payloads can exceed that. Per-chunk GCM with 64 KiB plaintext is nowhere near it.
  https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf
- **Node's streaming GCM emits unauthenticated plaintext**: verified that `decipher.update(ct)` returns the full plaintext bytes
  *before* `final()` throws on a bad tag ("update() before final() on bad tag yields 6 bytes of unauthenticated plaintext").
  With one giant GCM stream you would already have written gigabytes of attacker-controlled bytes to disk (and fed them to
  `tar.Unpack`) before learning the file was forged. With 64 KiB chunks we buffer each chunk's plaintext and only forward it
  after `final()` succeeds.
- **Early failure and truncation detection**: libsodium secretstream's stated properties are the target: "Messages cannot be
  truncated, removed, reordered, duplicated or modified without this being detected", "stream corruption will be detected early,
  without having to read the stream until the end", "There are no practical limits to the total length of the stream".
  https://doc.libsodium.org/secret-key_cryptography/secretstream
- age v1 uses the same STREAM variant with 64 KiB chunks and a last-chunk flag: "The payload is split in chunks of 64 KiB, and
  each of them is encrypted with ChaCha20-Poly1305, using the payload key and a 12-byte nonce composed as follows: the first 11
  bytes are a big endian chunk counter starting at zero and incrementing by one for each subsequent chunk; the last byte is
  0x01 for the final chunk and 0x00 for all preceding ones. The final chunk MAY be shorter than 64 KiB but MUST NOT be empty
  unless the whole payload is empty." and "Streaming decryption MUST signal an error if the end of file is reached without
  successfully decrypting a final chunk." https://age-encryption.org/v1#payload (construction from https://eprint.iacr.org/2015/189)
- Nonce uniqueness: the content key is unique per file (random master key + random payloadNonce through HKDF) and nonces are a
  deterministic counter, so there is no nonce reuse across chunks or files. NIST 8.3's 2^32-invocation limit applies to
  *random* IVs; with the deterministic construction the limit is 2^(counter bits) = 2^88 chunks (~2^104 bytes) per key.
  Node accepts a 16-byte IV for GCM (verified) - **enforce `iv.length === 12` in our code**, the 96-bit path is the only one
  that avoids GHASH-derived IVs.

### 5.1 Nonce and AAD

```
nonce(i, last) = BE88(i) || (last ? 0x01 : 0x00)          // 12 bytes; i = chunk index from 0
AAD            = SHA-256(header bytes [0, 44+L))            // 32 bytes, identical for every chunk of this file
```

### 5.2 Writer (pseudocode)

```
write(magic, version, L, headerJson, headerMac)          // header built in section 3
buf = empty; i = 0
for each plaintext piece p from the tar (or tar|gzip) stream:
    buf ||= p
    while len(buf) > CHUNK:                               // strictly greater: keep >= 1 byte for the final chunk
        emit seal(i++, last=false, buf[0:CHUNK]); buf = buf[CHUNK:]
at end of stream:
    if len(buf) == 0: error "empty payload"               // a tar stream is never empty (>= 1024 zero bytes)
    emit seal(i, last=true, buf)

seal(i, last, pt):
    c = createCipheriv('aes-256-gcm', contentKey, nonce(i,last), { authTagLength: 16 })
    c.setAAD(AAD)                                          // must precede update()
    return c.update(pt) || c.final() || c.getAuthTag()     // getAuthTag() only after final()
```

### 5.3 Reader (pseudocode)

```
read fixed 12 bytes; check magic, version; read L (<= 65536), JSON, MAC   // parse + bound-check JSON (4.1)
KEK = argon2id(password, kdf)                                              // in a worker
masterKey = unwrap(KEK, wrappedKey) or fail ARCHIVE_AUTH_FAILED
expectMac = HMAC-SHA-256(HKDF(masterKey, '', 'devbkp/v1/header-mac'), bytes[0,12+L))
if !timingSafeEqual(expectMac, headerMac): fail ARCHIVE_INVALID ("header modified")
contentKey = HKDF(masterKey, payloadNonce, 'devbkp/v1/payload'); AAD = SHA-256(bytes[0, 44+L))
CS = chunkSize + 16; i = 0
loop:
    ct = read up to CS bytes
    if len(ct) == 0: fail ARCHIVE_INVALID ("truncated: EOF before final chunk")
    peek = read 1 byte (or use file size); last = (len(ct) < CS) or (peek is EOF); if peek exists, push it back
    if len(ct) < 16 + (last ? 1 : 0): fail ARCHIVE_INVALID ("short chunk")
    d = createDecipheriv('aes-256-gcm', contentKey, nonce(i, last), { authTagLength: 16 })
    d.setAAD(AAD); d.setAuthTag(ct[-16:])                                  // setAuthTag before final() for GCM
    pt = d.update(ct[:-16]); d.final() or fail INTEGRITY_MISMATCH ("chunk i failed authentication")
    yield pt                                                               // only now
    if last: assert EOF (any trailing byte -> ARCHIVE_INVALID); stop
    i++
```

For a seekable file (our case) "last" is simply `remaining <= CS`. For a non-seekable stream keep a one-chunk lookahead.

### 5.4 Verified detection matrix (prototype: tar v7 + node:crypto + hash-wasm, 200 KB payload, 5 chunks)

| Mutation | Result |
| --- | --- |
| wrong password | `ARCHIVE_AUTH_FAILED` (wrap tag) |
| flip a byte in `kdf.iterations` | `ARCHIVE_AUTH_FAILED` (different KEK) |
| flip a byte in `createdAt` (not a KDF input) | `ARCHIVE_INVALID: header MAC mismatch` |
| flip a byte inside the JSON syntax | JSON parse error -> `ARCHIVE_INVALID` |
| flip one payload byte | `INTEGRITY_MISMATCH: chunk 4` (early, nothing after it is decrypted) |
| swap chunks 1 and 2 | `INTEGRITY_MISMATCH: chunk 1` (counter in nonce) |
| drop chunk 1 | `INTEGRITY_MISMATCH: chunk 1` |
| truncate mid-chunk (-1000 B) | `INTEGRITY_MISMATCH: chunk 4` (treated as final, wrong length/flag) |
| truncate at a chunk boundary (keep 3 chunks) | `INTEGRITY_MISMATCH: chunk 2` (encrypted with last=0, verified with last=1) |
| append 5 junk bytes | `INTEGRITY_MISMATCH: chunk 4` (boundary shift; in addition the reader asserts EOF after the final chunk) |
| keep header, replace chunk 0 with other data | `INTEGRITY_MISMATCH: chunk 0` (AAD = this header's hash) |
| `authTagLength` omitted on `createDecipheriv` | Node 22.22.3 **accepts 4/8/12-byte tags** (only 3 rejected); with `{authTagLength:16}` every non-16 tag -> `ERR_CRYPTO_INVALID_AUTH_TAG`. Always pass it and also check `tag.length === 16`. |

## 6. Threat notes

### 6.1 Stolen file (offline password guessing)

The only secret is the password; everything else in the header is public and the attacker can run Argon2id offline at full speed.
Per guess the attacker must do one Argon2id with our parameters (memory traffic roughly 3 x m x t ~ 2.3 GiB for m=256 MiB, t=3).
Rough upper bound from memory bandwidth: a ~1 TB/s GPU sustains at most a few hundred guesses/second (~430/s), ~4x more for the
m=64 MiB floor. Consequences (order-of-magnitude, single GPU):

- 10^6-entry wordlist: under an hour. **Weak passwords are not protected by any KDF**; the UI must enforce the model's
  `min(8)` and should show a strength meter / block top-list passwords.
- 10^9 candidates (8-char pattern spaces): about a month.
- Random 12+ character / 5-word passphrase (>= 70 bits): infeasible.
A 16-byte random salt per file removes precomputation and makes two backups with the same password independent.

### 6.2 Tampered file

- Any header byte: JSON parse failure, KEK change (wrap tag) or header-MAC mismatch; in all cases before any payload is touched.
  Every chunk additionally carries `AAD = SHA-256(header)`, so a payload cannot be transplanted under a different header
  (e.g. one that advertises weaker KDF params or another `payloadNonce`).
- Any payload byte / chunk reorder / duplicate / drop / splice from another backup: GCM tag failure at that chunk; the reader
  stops and nothing from that chunk onward is written (see 5.4). Because we buffer per chunk, at most 64 KiB of authenticated
  plaintext precedes the failure - never unauthenticated bytes.
- KDF downgrade: parameters are inputs to the KEK and covered by the MAC; the reader also enforces the floor from 2.4.

### 6.3 Truncated file

Truncation at a chunk boundary: the last present chunk was sealed with `last=0`, the reader (seeing EOF) verifies it with
`last=1` -> tag failure. Truncation mid-chunk -> length/tag failure. Truncation inside the header -> length checks fail
(`L` beyond file size). Zero-byte payload is rejected (a valid tar is >= 1024 bytes). Matches age's "MUST signal an error if
the end of file is reached without successfully decrypting a final chunk".

### 6.4 Wrong password vs. corrupted header

Both surface as a wrap-tag failure. This is intentional (age's password stanza has the same property): the file must not act
as an oracle that distinguishes "wrong password" from "wrong KDF params". The UI copy should say "Wrong password, or the file
is damaged", and the header-MAC error (which can only happen *after* a successful unwrap) should say "file modified".

### 6.5 What is not protected

- Header metadata is plaintext (creation time, app version, KDF cost, chunk count => approximate payload size). Keep labels,
  machine names and manifests inside the payload (they are).
- Compression inside encryption leaks plaintext-size information only; no adaptive chosen-plaintext oracle exists for a file
  at rest. Acceptable; keep `compression` optional.
- TOCTOU during extraction on a hostile filesystem (see node-tar README warning). Extract only into a fresh `mkdtemp` 0700
  directory that no other principal can write.

## 7. tar (node-tar v7): API, hardening, and entry validation

### 7.1 Classes and options that exist in v7 (verified in `tar@7.5.22` `dist/esm/*.d.ts`)

Exports from `tar`: `create/c`, `extract/x`, `list/t`, `update/u`, `replace/r`, classes `Pack`, `PackSync`, `Parser`, `Unpack`,
`UnpackSync`, `ReadEntry`, `WriteEntry`, `Header`, `Pax`, plus `types` (`EntryTypeName`/`EntryTypeCode`).

- `class Pack extends Minipass` - "A readable tar stream"; `add(path | ReadEntry): this`, `write(path): boolean`, `end()`.
  Constructor options: `cwd`, `prefix`, `gzip`, `filter(path, stat)`, `portable`, `preservePaths`, `follow`, `noPax`, `noMtime`,
  `mtime`, `onWriteEntry`, `jobs`, `maxReadSize`, `noDirRecurse`, `strict`, `onwarn`. https://github.com/isaacs/node-tar#class-pack
- `class Parser` - "A writable stream that parses a tar archive stream ... Emits 'entry' events with tar.ReadEntry objects, which
  are themselves readable streams". Options: `strict`, `filter(path, entry)`, `onReadEntry(entry)`, `onwarn`; `abort(error)`.
  "Each entry will not emit until the one before it is flushed through, so make sure to either consume the data ... or throw it
  away with .resume()". https://github.com/isaacs/node-tar#class-tarparser
- `class Unpack extends Parser` - "A writable stream that unpacks a tar archive onto the file system"; emits `'close'` when done.
  Options: `cwd` (must exist and be a directory), `filter`, `onReadEntry`, `strict`, `preservePaths`, `strip`, `unlink`, `keep`,
  `newer`, `chmod`, `processUmask`, `umask`, `dmode`, `fmode`, `preserveOwner`, `uid/gid`, `noMtime`, `transform`, `maxDepth`
  (default 1024), `maxMetaEntrySize` (default 1 MB), `maxDecompressionRatio` (default 1000; only applies when tar itself gunzips).
  https://github.com/isaacs/node-tar#class-unpack
- `class ReadEntry extends Minipass` fields: `path`, `type: EntryTypeName`, `size`, `mode`, `linkpath?`, `remain`, `meta`, `ignore`,
  `extended`, `globalExtended`. `EntryTypeName` = `'File' | 'OldFile' | 'Link' | 'SymbolicLink' | 'CharacterDevice' | 'BlockDevice' |
  'Directory' | 'FIFO' | 'ContiguousFile' | 'GlobalExtendedHeader' | 'ExtendedHeader' | ... | 'Unsupported'`.
- `filter` semantics (README "Examples"): "Tar-creating methods call the filter with filter(path, stat). Tar-reading methods
  (including extraction) call the filter with filter(path, entry)." Verified: `Parser` passes only filesystem entries to the
  filter (PAX meta entries are handled internally) and `Directory` paths arrive **with a trailing slash** (`payload/`).
- `strip`: "the pathname is edited after applying the filter, but before security checks" -> we use `strip: 0`.
- Node `stream/promises.pipeline()` accepts a `Pack` (Minipass) directly as a source and an `Unpack` as destination (verified;
  `Readable.from(pack)` also works).

### 7.2 Built-in hardening (README "Security Information", all disabled by `preservePaths: true`)

"Paths that attempt to walk up outside of the extraction target are ignored, and a warning is raised", "Link and SymbolicLink
entries are not allowed to target locations outside of the extraction folder", "Extraction is not allowed through a symbolic link",
"Absolute paths are turned into relative paths underneath the extraction target", "Character Device, Block Device, and FIFO entries
are never extracted", ownership/modes not mutated unless `forceChown`/`chmod`, path-reservation against parallel-entry races,
"Unicode characters in path names are fully normalized". Then the warning: "NEVER extract tarball data into a folder that could be
potentially controlled by an unknown actor", "it is highly recommended that you use a filter function that rejects all hardlinks and
symbolic links. Link files are historically the root of nearly every file extraction vulnerability", and "filter out any files that
are excessively large" when the archive is compressed. https://github.com/isaacs/node-tar#security-information

Verified behaviour of a hostile archive (`../escape.txt`, `/abs/path.txt`, symlink to `/etc/passwd`, hardlink `../../outside`, FIFO)
against `new Unpack({ cwd })` defaults: `TAR_ENTRY_ERROR path contains '..'` (skipped), `TAR_ENTRY_INFO stripping / from absolute path`
(extracted as `abs/path.txt`), `TAR_ENTRY_INFO stripping / from absolute linkpath` (symlink **was created**, now pointing at
`etc/passwd` relative to cwd), `TAR_ENTRY_ERROR linkpath contains '..'` (skipped), `TAR_ENTRY_UNSUPPORTED unsupported entry type: FIFO`.
With `strict: true` each of those became an `'error'` event with `error.tarCode` set, i.e. `TAR_ENTRY_INFO` (absolute path stripping)
is also fatal in strict mode. Because our writer never produces absolute paths, strict mode is the right default for us.

Warning codes (README "Error Codes"): `TAR_ENTRY_INFO`, `TAR_ENTRY_INVALID`, `TAR_ENTRY_ERROR`, `TAR_ENTRY_UNSUPPORTED`, `TAR_ABORT`,
`TAR_BAD_ARCHIVE` ("An entry body was truncated before seeing the full number of bytes" -> unrecoverable for extraction; "tar WILL
still have extracted as much it could from the archive, so there may be some garbage files to clean up").

### 7.3 Entry validation checklist (restore side, applied in `filter(path, entry)` before tar's own checks)

1. **Type allowlist**: `entry.type === 'File' || entry.type === 'Directory'`; everything else (`Link`, `SymbolicLink`,
   `CharacterDevice`, `BlockDevice`, `FIFO`, `ContiguousFile`, `Unsupported`, ...) -> reject (`ARCHIVE_ENTRY_REJECTED`).
   Our own writer never emits links (see 7.5), so any link is evidence of tampering or a foreign file.
2. **Path syntax** (after stripping one trailing `/` for `Directory`): non-empty; no NUL; no `\`; `path.split('/')` has no
   `''`, `.` or `..` segments; does not start with `/`; no drive-letter prefix (`/^[A-Za-z]:/`, CVE-2021-37713 shape); length <= 4096;
   depth <= 64 (also set `maxDepth: 64`).
3. **Unicode**: compare and dedupe paths after `normalize('NFC')`; tar normalizes internally but our manifest matching must too.
4. **Case-insensitive collisions**: macOS APFS default volumes are case-insensitive; reject an archive containing two paths equal
   under `toLowerCase()` (a later entry would silently overwrite the earlier one, or race with tar's reservation system).
5. **Allowlist against the manifest**: the first entry must be `manifest.json` (parse + zod-validate it before accepting any other
   entry); every subsequent path must be `checksums.json` or start with a `payloadPath` declared in the manifest. Unknown paths ->
   reject. Duplicate paths -> reject (do not rely on `keep`).
6. **Size limits**: `entry.size` must be `<= declared sizeBytes` for that artifact, running total `<= manifest.stats.payloadBytes`
   plus a small slack, entry count `<= manifestArtifactCount + fileCount sum`; abort the whole restore on exceed
   (`ARCHIVE_LIMIT_EXCEEDED`). If `compression: 'gzip'` is used, gunzip in *our* pipeline with a byte-counting `Transform` that caps
   output at the manifest total (tar's `maxDecompressionRatio` only guards tar's own gunzip; GHSA-23hp-3jrh-7fpw).
7. **Extraction target**: a fresh `fs.mkdtemp` directory (0700, verified) under the app's data dir, never a user-chosen or
   pre-existing folder (README item 1 / TOCTOU). Unpack options: `{ cwd, strict: true, preservePaths: false, strip: 0, maxDepth: 64,
   chmod: false, preserveOwner: false, unlink: false, keep: false, noMtime: false, filter, onReadEntry, onwarn }`.
8. **Post-extraction integrity**: after `'close'`, read `checksums.json` (last entry) and verify every file's SHA-256 and size
   (`INTEGRITY_MISMATCH` on mismatch); only then let the restore planner move files into place.
9. **Cleanup**: on any error or abort, `rm(stagingDir, { recursive: true, force: true })`; tar warns that partial extraction leaves
   files behind (`TAR_BAD_ARCHIVE`).
10. **Never** set `preservePaths`, `P`, `unlink`, `chmod`, `uid/gid`, or `follow` on the read side.

### 7.4 Known node-tar extraction vulnerabilities (why 1, 2, 6 and 7 above exist)

| Advisory | Class | Affected -> fixed |
| --- | --- | --- |
| CVE-2021-32803 (GHSA-r628-mhmh-qjhw) | symlink path traversal via directory cache poisoning ("Arbitrary File Creation, Arbitrary File Overwrite, Arbitrary Code Execution") | 4.x < 4.4.15, 5.x < 5.0.7 -> 4.4.15 / 5.0.7 |
| CVE-2021-32804 (GHSA-3jfq-g458-7qm9) | absolute-path stripping bypass (`//` and drive prefixes) | < 3.2.2, 4.x < 4.4.14 -> 3.2.2 / 4.4.14 |
| CVE-2021-37701 (GHSA-9r2w-394v-53qc), CVE-2021-37712 (GHSA-qq89-hq3f-393p) | symlink traversal via unicode / case / path-separator equivalence in the directory cache | fixed in 4.4.16-4.4.18 / 5.0.8-5.0.10 / 6.1.7-6.1.9 |
| CVE-2021-37713 (GHSA-5955-9wpr-37jh) | `..` and drive-relative (`c:../`) path bypass on Windows | < 4.4.18, 5.x < 5.0.10 -> 4.4.18 / 5.0.10 |
| CVE-2024-28863 (GHSA-f5x3-32g6-xq36) | DoS: no folder-depth limit (introduced `maxDepth`) | < 6.2.1 -> 6.2.1 |
| CVE-2026-24842 (GHSA-34x7-hfp2-rc4v) | **hardlink** path traversal: check vs. creation used different path resolution | reported against `^7.5.0`, published Jan 27 2026; fixed in a later 7.5.x (use >= 7.5.22) |
| CVE-2026-26960 (GHSA-83g3-92jg-28cx) | hardlink target escape through a symlink chain, default options, "arbitrary file read and write as the extracting user" | reported against 7.5.7, published Feb 16 2026; fixed in a later 7.5.x (use >= 7.5.22) |
| CVE-2026-31802 (GHSA-9ppj-qmqm-q256) and GHSA-qffp-2rhf-9h96 | drive-relative `linkpath` (`C:../../x`) symlink / hardlink traversal | <= 7.5.10 -> 7.5.11 |
| CVE-2026-59873 (GHSA-23hp-3jrh-7fpw) | decompression DoS: no cap on total decompressed bytes / entry count ("Gzip Bomb") | <= 7.5.18 -> 7.5.19 |
| CVE-2026-73566 (GHSA-r292-9mhp-454m) | uncatchable stack overflow in `list`/`extract` member selection with long paths | <= 7.5.20 -> 7.5.21 |
| GHSA-vmf3-w455-68vh, GHSA-gvwx-54wh-qm9j, GHSA-w8wr-v893-vjvp, GHSA-8x88-c5mf-7j5w | PAX/GNU long-name parser differentials, NUL-byte / numeric-path crashes, negative size infinite loop in `replace` | fixed in 7.5.x releases through 7.5.22 |

Sources: https://github.com/isaacs/node-tar/security/advisories and https://github.com/advisories/<GHSA-id>.
Takeaways: (a) three of the four 2026 traversal bugs are **hardlink** bugs and every 2021 one is a symlink bug - rejecting both
types in our filter removes the whole class regardless of future tar bugs; (b) pin `tar` to `^7.5.22` (latest today) and let
Renovate/Dependabot track it; (c) never pass a member-selection list to `list`/`extract` on untrusted input (GHSA-r292); (d) do not
use `tar.replace`/`tar.update` on untrusted archives.

### 7.5 Pack-side settings (backup)

`new Pack({ cwd: stagingDir, portable: true, follow: false, preservePaths: false, noMtime: false, strict: true, filter })` where
`filter(path, stat)` returns `stat.isFile() || stat.isDirectory()` (drops symlinks, sockets, FIFOs; `stat` is the `lstat` result
because `follow` is false). Add entries with explicit relative paths (`pack.add('manifest.json')` first, `pack.add('payload')`,
`pack.add('checksums.json')` last), then `pack.end()`. `portable: true` omits `uid/gid/uname/gname/dev/ino/nlink/atime/ctime`
and normalises modes (README `portable`), which is what we want for a cross-machine format. Git worktrees can contain symlinks;
the provider must materialise or skip them *before* packing and record that in the manifest rather than letting tar archive
`SymbolicLink` entries.

## 8. Streams, temp files, atomic writes, cancellation (Node 22)

- `stream/promises.pipeline(source, ...transforms, destination, { signal })`: "When the signal is aborted, destroy will be called on
  the underlying pipeline, with an AbortError." Async-generator stages receive `{ signal }` as their second argument and must honour
  it ("Remember to handle the signal argument passed into the async generator ... or the pipeline will never complete").
  Verified: abort -> rejection with `name: 'AbortError'`, `code: 'ABORT_ERR'` -> map to `CANCELLED`.
  https://nodejs.org/api/stream.html#streampipelinesource-transforms-destination-options
- `fsPromises.mkdtemp(prefix)`: "A unique directory name is generated by appending six random characters to the end of the provided
  prefix"; prefix must end with `path.sep` to create *inside* a directory. Verified mode **0700** on macOS. Node >= 24.4 also has
  `mkdtempDisposable` (`await using`), not available on our Node 22 baseline. https://nodejs.org/api/fs.html#fspromisesmkdtempprefix-options
- `fs.createWriteStream(path, { flags: 'wx', mode: 0o600, flush: true, signal })`: `flush` - "If true, the underlying file descriptor is
  flushed prior to closing it. Default: false." (= fsync before close); `'wx'` fails if the temp file already exists; `mode` 0o600 keeps
  the partially written archive private; `signal` destroys the stream on abort. Verified: resulting file mode 600. For belt and braces
  open with `fsPromises.open` and call `filehandle.sync()` ("Request that all data for the open file descriptor is flushed to the storage
  device") before `rename`. https://nodejs.org/api/fs.html#fscreatewritestreampath-options
- `fsPromises.rename(oldPath, newPath)` replaces `newPath` atomically on the same filesystem (POSIX `rename(2)`); write the `.part`
  file in the **same directory** as the final `.devbackup` (not in `os.tmpdir()`, which may be another volume) so the rename is atomic
  and not a copy. Verified: rename over an existing file.
- `fsPromises.rm(path, { recursive: true, force: true })` = `rm -rf` ("To get a behavior similar to the rm -rf Unix command, use
  fsPromises.rm() with options { recursive: true, force: true }"); `maxRetries`/`retryDelay` help with transient `EBUSY`/`ENOTEMPTY`.
  https://nodejs.org/api/fs.html#fspromisesrmpath-options
- Write flow: `mkdtemp` staging (0700) for provider outputs -> `pipeline(pack, [gzip], encryptor, ws)` to `<final>.part` -> `rename`
  -> `rm` staging. Restore flow: header + KDF (worker) -> `pipeline(fileReadStream, decryptor, [gunzip+cap], unpack)` into
  `mkdtemp` staging -> checksums -> planner. Both wrapped in `try/finally { rm(staging) }` and both take the job's `AbortSignal`.

## 9. Code-level API usage (all snippets exercised in the prototype)

### 9.1 KDF and key wrap (`hash-wasm` + `node:crypto`)

```ts
import { argon2id } from 'hash-wasm'
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

const MAGIC = Buffer.from('DEVBKP'); const VERSION = 1; const TAG = 16
const wrapAad = Buffer.concat([MAGIC, Buffer.from([0, VERSION])])
const hkdf = (ikm: Buffer, salt: Buffer, info: string) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32)) // ArrayBuffer -> Buffer

// --- backup (run argon2id inside a worker_thread; see 2.1) ---
const salt = randomBytes(16)
const kdf = { algorithm: 'argon2id', version: 19, salt: salt.toString('base64'), memoryKiB: 262144, iterations: 3, parallelism: 4, hashLength: 32 }
const kek = Buffer.from(await argon2id({ password: password.normalize('NFC'), salt, memorySize: kdf.memoryKiB,
  iterations: kdf.iterations, parallelism: kdf.parallelism, hashLength: 32, outputType: 'binary' }))
const masterKey = randomBytes(32)
const w = createCipheriv('aes-256-gcm', kek, Buffer.alloc(12, 0), { authTagLength: TAG }); w.setAAD(wrapAad)
const wrappedKey = Buffer.concat([w.update(masterKey), w.final(), w.getAuthTag()])           // 48 bytes
const payloadNonce = randomBytes(16)
const json = Buffer.from(JSON.stringify({ format: 'devbackup', formatVersion: VERSION, createdAt: new Date().toISOString(), kdf,
  wrap: { algorithm: 'aes-256-gcm', wrappedKey: wrappedKey.toString('base64') },
  cipher: { algorithm: 'aes-256-gcm', chunkSize: 65536, payloadNonce: payloadNonce.toString('base64') },
  payload: { format: 'tar', compression: 'none' } }))
const fixed = Buffer.alloc(12); MAGIC.copy(fixed); fixed.writeUInt16BE(VERSION, 6); fixed.writeUInt32BE(json.length, 8)
const preMac = Buffer.concat([fixed, json])
const headerMac = createHmac('sha256', hkdf(masterKey, Buffer.alloc(0), 'devbkp/v1/header-mac')).update(preMac).digest()
const header = Buffer.concat([preMac, headerMac])
const contentKey = hkdf(masterKey, payloadNonce, 'devbkp/v1/payload')
const aad = createHash('sha256').update(header).digest()

// --- restore ---
const wrapped = Buffer.from(hdr.wrap.wrappedKey, 'base64'); if (wrapped.length !== 48) throw invalid()
let masterKey2: Buffer
try {
  const d = createDecipheriv('aes-256-gcm', kek, Buffer.alloc(12, 0), { authTagLength: TAG })
  d.setAAD(wrapAad); d.setAuthTag(wrapped.subarray(32))
  masterKey2 = Buffer.concat([d.update(wrapped.subarray(0, 32)), d.final()])
} catch { throw authFailed() }                                            // wrong password OR modified header
const expect = createHmac('sha256', hkdf(masterKey2, Buffer.alloc(0), 'devbkp/v1/header-mac')).update(bytes.subarray(0, 12 + L)).digest()
if (!timingSafeEqual(expect, headerMac)) throw invalid('header MAC mismatch')
```

### 9.2 Chunk seal / open (`node:crypto`)

```ts
function nonce(i: number, last: boolean): Buffer {   // 11-byte BE counter || last flag; i < 2^53 is plenty
  const n = Buffer.alloc(12); n.writeUInt32BE(Math.floor(i / 2 ** 32), 3); n.writeUInt32BE(i % 2 ** 32, 7); n[11] = last ? 1 : 0; return n
}
function seal(key: Buffer, aad: Buffer, i: number, last: boolean, pt: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonce(i, last), { authTagLength: 16 })
  c.setAAD(aad)                                                            // before update()
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()])          // getAuthTag() after final()
}
function open(key: Buffer, aad: Buffer, i: number, last: boolean, ct: Buffer): Buffer {
  if (ct.length < 16 + (last ? 1 : 0)) throw invalid('short chunk')
  const d = createDecipheriv('aes-256-gcm', key, nonce(i, last), { authTagLength: 16 })
  d.setAAD(aad); d.setAuthTag(ct.subarray(ct.length - 16))                 // for GCM: setAuthTag before final()
  const pt = d.update(ct.subarray(0, ct.length - 16))
  d.final()                                                                // throws on any tampering; pt is only released after this
  return pt
}
```

Encryptor as a `Transform` (buffer until `> CHUNK`, seal `CHUNK` bytes with `last=false`; in `flush` seal the remainder with
`last=true`, error if empty). Decryptor as an async generator over a `FileHandle` (read `chunkSize+16`, `last = remaining <= chunkSize+16`).

### 9.3 tar v7

```ts
import { Pack, Unpack, type ReadEntry } from 'tar'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { Stats } from 'node:fs'

// backup: staging dir -> tar stream -> encrypt -> file
const pack = new Pack({ cwd: stagingDir, portable: true, follow: false, preservePaths: false, strict: true,
  filter: (_path: string, stat: Stats) => stat.isFile() || stat.isDirectory() })
pack.add('manifest.json'); pack.add('payload'); pack.add('checksums.json'); pack.end()
await pipeline(pack, encryptorTransform, ws, { signal })                   // Pack (Minipass) is accepted directly

// restore: decrypted chunks -> Unpack into a fresh mkdtemp dir
const unpack = new Unpack({
  cwd: extractDir, strict: true, preservePaths: false, strip: 0, maxDepth: 64, chmod: false, preserveOwner: false,
  filter: (p: string, e: ReadEntry) => {
    const rel = e.type === 'Directory' ? p.replace(/\/$/, '') : p           // dirs arrive as "payload/"
    const okType = e.type === 'File' || e.type === 'Directory'
    const segs = rel.split('/')
    const okPath = rel.length > 0 && !rel.includes('\0') && !rel.includes('\\') && !/^[A-Za-z]:/.test(rel)
      && !segs.some((s) => s === '' || s === '.' || s === '..') && segs.length <= 64
    return okType && okPath && manifestAllows(rel, e.size)                 // 7.3 items 5-6
  },
  onReadEntry: (e) => { bytesSeen += e.size; if (bytesSeen > cap) unpack.abort(limitExceeded()) },
  onwarn: (code, message, data) => log.warn({ code, message, path: data?.entry?.path }),
})
await pipeline(Readable.from(decryptChunks(fileHandle, contentKey, aad)), unpack, { signal })
```

### 9.4 Atomic file write with cleanup

```ts
import { mkdtemp, rename, rm, open } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join, basename } from 'node:path'

const staging = await mkdtemp(join(app.getPath('userData'), 'staging', 'bk-'))   // 0700
const part = join(dirname(outputPath), `.${basename(outputPath)}.part`)         // same volume as the destination
try {
  const ws = createWriteStream(part, { flags: 'wx', mode: 0o600, flush: true, signal })
  await pipeline(headerAndPayloadSource, ws, { signal })
  await rename(part, outputPath)                                                  // atomic replace
} catch (err) {
  await rm(part, { force: true })
  throw err                                                                       // AbortError -> CANCELLED
} finally {
  await rm(staging, { recursive: true, force: true, maxRetries: 3 })
}
```

## 10. Open questions

1. Compression: `gzip` (zlib, universally available) vs `zstd` (Node 22.15+ `zlib.createZstdCompress`, experimental on 22). Claude
   JSONL compresses ~5-10x; decide on `payload.compression` default and add the decompression byte cap (7.3 item 6) if enabled.
2. Should the reader accept KDF params *below* the RFC option-2 floor (m < 64 MiB) for files written by a constrained fallback, or
   refuse them? Current recommendation: refuse, and never write them.
3. Where to run Argon2id in Electron: `worker_threads` inside the main process vs `utilityProcess`. Both keep the main loop responsive;
   `utilityProcess` also isolates the 256 MiB WASM heap and can be killed to reclaim memory.
4. Whether to add an optional `secret` (Argon2 pepper) bound to the machine Keychain for "same-user only" backups - out of scope for v1
   because the file must be portable between Macs.
5. `BackupHeaderInfo.kdf` in `packages/model/src/backup.ts` lacks `salt`, `hashLength` and `version`; the header JSON above adds them
   (the zod schema can keep ignoring unknown keys or be extended).
