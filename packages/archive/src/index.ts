export * from './types'
export { createDevBackup } from './create'
export {
  readDevBackupHeader,
  buildHeader,
  encodeHeader,
  parseHeaderBytes,
  DevBackupHeaderSchema,
  type ParsedHeader,
  type HeaderFields,
} from './header'
export { inspectDevBackup } from './inspect'
export { extractDevBackup } from './extract'
export { verifyDevBackup } from './verify'
export {
  computeChecksums,
  writeChecksumsFile,
  parseChecksums,
  verifyChecksumsAgainstDir,
  type ComputeChecksumsOptions,
  type VerifyChecksumsOptions,
} from './checksums'
export {
  deriveKeyFromPassword,
  validateKdfParams,
  resolveKdfPreset,
  decodeBase64,
  type DeriveKeyOptions,
} from './kdf'
export {
  generateMasterKey,
  wrapMasterKey,
  unwrapMasterKey,
  deriveContentKey,
  hashHeaderBytes,
} from './keys'
export {
  createEncryptStream,
  createDecryptStream,
  sealChunk,
  openChunk,
  buildChunkNonce,
  buildChunkAad,
  type ChunkCipherOptions,
  type DecryptStreamOptions,
  type EncryptStream,
  type DecryptStream,
} from './crypto-stream'
export { EntryGuard, resolveLimits, type AcceptedEntry } from './entry-guard'
export { openDevBackup, type OpenedDevBackup } from './open'
export { walkTree, comparePosixPaths, type TreeEntry } from './tree'
export {
  DEFAULT_KDF_PARAMS,
  FAST_KDF_PARAMS,
  KDF_BOUNDS,
  DEFAULT_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  FORMAT_VERSION,
  MAGIC_STRING,
  MAX_HEADER_JSON_LENGTH,
  MANIFEST_ENTRY,
  CHECKSUMS_ENTRY,
  PARTIAL_SUFFIX,
  DEFAULT_MAX_DEPTH,
  type KdfPreset,
} from './constants'
