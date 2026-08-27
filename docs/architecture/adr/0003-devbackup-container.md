# ADR-0003: The .devbackup container

**Status:** accepted · 2026-08-27

## Decision

A `.devbackup` file = unencrypted authenticated header + chunked AES-256-GCM ciphertext of a tar stream.

- Random 32-byte master key; password → KEK with **Argon2id** (hash-wasm, WASM — no native module); master key wrapped with AES-256-GCM.
- Content key and header-MAC key derived from the master key with HKDF-SHA256.
- Payload is a tar stream (`manifest.json` first, `checksums.json` last) encrypted in fixed-size chunks (default 1 MiB); nonce = counter ‖ last-chunk flag, AAD = SHA-256 of the header ‖ chunk index. Truncation, reordering and header tampering are detected; wrong passwords fail at key-unwrap before any payload is touched.
- Streaming everywhere: hashing, packing, encryption, decryption and extraction never load the payload into memory.
- Restore treats the file as untrusted: zod-validated manifest, rejected tar entries (`..`, absolute, symlink/hardlink, over-long, over-size), entry/total limits, checksum verification, fail closed.

Full byte layout: `docs/backup-format/DEVBACKUP_SPEC.md`. Threats: `docs/security/THREAT_MODEL.md`.

## Why

Backups contain source code, transcripts (which may echo secrets) and possibly `.env` files. Encryption by default with a memory-hard KDF is the minimum responsible design; chunked AEAD gives early failure and no GCM size limits; a plain tar payload keeps the format inspectable with standard tools after decryption.
