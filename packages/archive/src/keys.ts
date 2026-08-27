/**
 * Key hierarchy (see DEVBACKUP_SPEC.md §4):
 *   KEK = Argon2id(password, salt)
 *   wrappedMasterKey = nonce || AES-256-GCM(KEK, nonce, masterKey, aad = "devbackup-kek-v1") || tag
 *   contentKey = HKDF-SHA-256(ikm = masterKey, salt = kdf salt, info = "devbackup/content/v1", 32)
 *   headerHash = SHA-256(magic || formatVersion || headerJsonLength || headerJson)
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { MigrationError } from '@devmig/shared'
import {
  CIPHER_ALGORITHM,
  CONTENT_KEY_INFO,
  CONTENT_KEY_LENGTH,
  GCM_NONCE_LENGTH,
  GCM_TAG_LENGTH,
  KEK_LENGTH,
  KEK_WRAP_AAD,
  MASTER_KEY_LENGTH,
  WRAPPED_KEY_LENGTH,
} from './constants'

export function generateMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_LENGTH)
}

export function generateSalt(length: number): Buffer {
  return randomBytes(length)
}

/** Returns nonce(12) || ciphertext(32) || tag(16). */
export function wrapMasterKey(kek: Buffer, masterKey: Buffer): Buffer {
  if (kek.length !== KEK_LENGTH) throw new Error('KEK must be 32 bytes')
  if (masterKey.length !== MASTER_KEY_LENGTH) throw new Error('master key must be 32 bytes')
  const nonce = randomBytes(GCM_NONCE_LENGTH)
  const cipher = createCipheriv(CIPHER_ALGORITHM, kek, nonce, { authTagLength: GCM_TAG_LENGTH })
  cipher.setAAD(KEK_WRAP_AAD)
  const ct = Buffer.concat([cipher.update(masterKey), cipher.final()])
  return Buffer.concat([nonce, ct, cipher.getAuthTag()])
}

/**
 * Unwraps the master key. A wrong password (or a modified KDF/wrap field) fails here, before any
 * payload byte is read: ARCHIVE_AUTH_FAILED. The two causes are indistinguishable by design.
 */
export function unwrapMasterKey(kek: Buffer, wrapped: Buffer): Buffer {
  if (wrapped.length !== WRAPPED_KEY_LENGTH) {
    throw new MigrationError('ARCHIVE_INVALID', 'The wrapped master key has an invalid length.', {
      details: { length: wrapped.length, expected: WRAPPED_KEY_LENGTH },
    })
  }
  const nonce = wrapped.subarray(0, GCM_NONCE_LENGTH)
  const ct = wrapped.subarray(GCM_NONCE_LENGTH, GCM_NONCE_LENGTH + MASTER_KEY_LENGTH)
  const tag = wrapped.subarray(GCM_NONCE_LENGTH + MASTER_KEY_LENGTH)
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, kek, nonce, {
      authTagLength: GCM_TAG_LENGTH,
    })
    decipher.setAAD(KEK_WRAP_AAD)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new MigrationError(
      'ARCHIVE_AUTH_FAILED',
      'The password is wrong, or the backup header was modified.',
      { hint: 'Check the password and try again.', recoverable: true },
    )
  }
}

export function deriveContentKey(masterKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, salt, CONTENT_KEY_INFO, CONTENT_KEY_LENGTH))
}

/** SHA-256 over the raw header bytes (magic .. headerJson); every payload chunk binds it via AAD. */
export function hashHeaderBytes(headerBytes: Buffer): Buffer {
  return createHash('sha256').update(headerBytes).digest()
}
