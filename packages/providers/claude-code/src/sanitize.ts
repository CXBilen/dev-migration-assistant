/**
 * Transcript sanitizer used by `pnpm fixture:claude` (scripts/fixture-claude.ts).
 *
 * Keeps the record shapes (keys, arrays, nesting, numbers, booleans, timestamps) and replaces every
 * free-text string with `REDACTED (<n> chars)`. Absolute paths under the real home directory are
 * remapped to a fake home / project, ids (uuids, msg_/req_/toolu_) are remapped deterministically.
 * The result must never contain the real user name or anything the secret redactor would flag.
 */
import { MigrationError, redactSecrets } from '@devmig/shared'
import { PATH_BEARING_FIELDS, type JsonRecord } from './transcript'

export interface SanitizeOptions {
  /** Real home directory of the source machine (e.g. /Users/<user>). */
  homeDir: string
  /** Real user name (basename of homeDir by default). */
  userName?: string
  /** Real project path the transcript ran in (its subtree is remapped to fakeProjectPath). */
  projectPath?: string
  /** Fake home written into the fixture (default /Users/alice). */
  fakeHomeDir?: string
  /** Fake project path (default <fakeHomeDir>/Documents/GitHub/demo). */
  fakeProjectPath?: string
}

export interface Sanitizer {
  /** Sanitizes one JSONL line. Invalid JSON lines become `REDACTED-INVALID-LINE (<n> chars)`. */
  line(text: string): string
  /** Remaps an id (uuid / msg_ / req_ / toolu_) deterministically; used for the output file name. */
  mapId(id: string): string
  /** Throws when `text` still contains the real user name or a secret-looking value. */
  assertClean(text: string): void
  /** Number of strings replaced so far. */
  readonly redactedStrings: number
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
/** Numeric values under keys like `*_tokens` are zeroed: the conservative secret redactor would otherwise flag them. */
const SECRET_LIKE_KEY_RE =
  /token|secret|password|passwd|pwd|auth|api[_-]?key|access[_-]?key|private[_-]?key|session[_-]?key/i
const PREFIXED_ID_RE = /\b(msg|req|toolu|srvtoolu|agent)_[A-Za-z0-9]{6,}\b/g

/** Top-level keys whose whole subtree is free text / tool output and gets redacted. */
const REDACT_ZONES = new Set([
  'message',
  'toolUseResult',
  'attachment',
  'content',
  'display',
  'lastPrompt',
  'aiTitle',
  'customTitle',
  'agentName',
  'pastedContents',
  'summary',
])

/** Path-bearing leaves inside toolUseResult keep their (remapped) path instead of being redacted. */
const KEEP_PATH_FIELDS = new Set(
  PATH_BEARING_FIELDS.filter((f) => f.startsWith('toolUseResult.')).map((f) =>
    f.slice('toolUseResult.'.length),
  ),
)

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fakeUuid(index: number): string {
  const hex = index.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

export function createSanitizer(options: SanitizeOptions): Sanitizer {
  const homeDir = options.homeDir.replace(/\/+$/, '')
  if (!homeDir.startsWith('/')) {
    throw new MigrationError('INVALID_INPUT', 'homeDir must be an absolute path')
  }
  const userName = options.userName ?? homeDir.split('/').pop() ?? ''
  if (!userName)
    throw new MigrationError('INVALID_INPUT', 'userName could not be derived from homeDir')
  const fakeHome = options.fakeHomeDir ?? '/Users/alice'
  const fakeProject = options.fakeProjectPath ?? `${fakeHome}/Documents/GitHub/demo`
  const projectPath = options.projectPath?.replace(/\/+$/, '')
  const ids = new Map<string, string>()
  let uuidCounter = 0
  let prefixedCounter = 0
  let redactedStrings = 0

  const mapId = (id: string): string => {
    const existing = ids.get(id)
    if (existing) return existing
    let mapped: string
    if (/^[0-9a-f-]{36}$/i.test(id)) {
      uuidCounter += 1
      mapped = fakeUuid(uuidCounter)
    } else {
      prefixedCounter += 1
      const prefix = id.split('_')[0] ?? 'id'
      mapped = `${prefix}_fixture${String(prefixedCounter).padStart(4, '0')}`
    }
    ids.set(id, mapped)
    return mapped
  }

  const encode = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-')
  const userTokenRe = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(userName)}(?=[^A-Za-z0-9]|$)`, 'g')
  const mapPathsIn = (text: string): string => {
    let out = text
    if (projectPath) {
      out = out.split(projectPath).join(fakeProject)
      out = out.split(encode(projectPath)).join(encode(fakeProject))
    }
    out = out.split(homeDir).join(fakeHome)
    out = out.split(encode(homeDir)).join(encode(fakeHome))
    out = out.split(`/${userName}/`).join('/alice/')
    out = out.replace(userTokenRe, (_m, prefix: string) => `${prefix}alice`)
    out = out.replace(UUID_RE, (m) => mapId(m.toLowerCase()))
    out = out.replace(PREFIXED_ID_RE, (m) => mapId(m))
    return out
  }

  const isAbsolutePathUnderHome = (value: string): boolean =>
    (value === homeDir || value.startsWith(`${homeDir}/`)) && !/\s/.test(value)

  const redactString = (value: string): string => {
    redactedStrings += 1
    return `REDACTED (${value.length} chars)`
  }

  const walkZone = (value: unknown, pathInZone: string): unknown => {
    if (typeof value === 'string') {
      if (KEEP_PATH_FIELDS.has(pathInZone) && value.startsWith('/')) return mapPathsIn(value)
      return redactString(value)
    }
    if (Array.isArray(value)) return value.map((v, i) => walkZone(v, `${pathInZone}[${i}]`))
    if (isObject(value)) {
      const out: JsonRecord = {}
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === 'number' && SECRET_LIKE_KEY_RE.test(k)) {
          out[k] = 0
          continue
        }
        // Keep structural discriminators of content blocks so shapes stay recognisable.
        if (
          (k === 'type' || k === 'role' || k === 'name') &&
          typeof v === 'string' &&
          v.length <= 40 &&
          !/\s/.test(v)
        ) {
          out[k] = mapPathsIn(v)
          continue
        }
        if ((k === 'id' || k === 'tool_use_id' || k === 'model') && typeof v === 'string') {
          out[k] = mapPathsIn(v)
          continue
        }
        out[k] = walkZone(v, pathInZone ? `${pathInZone}.${k}` : k)
      }
      return out
    }
    return value
  }

  const walkRecord = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return isAbsolutePathUnderHome(value) || value.startsWith('/')
        ? mapPathsIn(value)
        : mapPathsIn(value)
    }
    if (Array.isArray(value)) return value.map(walkRecord)
    if (isObject(value)) {
      const out: JsonRecord = {}
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === 'number' && SECRET_LIKE_KEY_RE.test(k)) {
          out[k] = 0
          continue
        }
        out[k] = REDACT_ZONES.has(k) ? walkZone(v, '') : walkRecord(v)
      }
      return out
    }
    return value
  }

  const assertClean = (text: string): void => {
    userTokenRe.lastIndex = 0
    if (text.includes(homeDir) || text.includes(encode(homeDir)) || userTokenRe.test(text)) {
      throw new MigrationError(
        'INVALID_INPUT',
        'Sanitized output still contains the real home directory or user name',
      )
    }
    if (redactSecrets(text) !== text) {
      throw new MigrationError(
        'INVALID_INPUT',
        'Sanitized output still contains a secret-looking value',
      )
    }
  }

  return {
    line(text: string): string {
      if (text.trim() === '') return text
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return `REDACTED-INVALID-LINE (${text.length} chars)`
      }
      if (!isObject(parsed)) return `REDACTED-INVALID-LINE (${text.length} chars)`
      const sanitized = walkRecord(parsed)
      const out = JSON.stringify(sanitized)
      assertClean(out)
      return out
    },
    mapId,
    assertClean,
    get redactedStrings() {
      return redactedStrings
    },
  }
}

/** Sanitizes whole transcript text (lines joined by '\n'). Convenience for tests. */
export function sanitizeTranscript(
  text: string,
  options: SanitizeOptions,
): { text: string; sanitizer: Sanitizer } {
  const sanitizer = createSanitizer(options)
  const lines = text.split('\n')
  const trailing = lines.length > 0 && lines[lines.length - 1] === '' ? lines.pop() : undefined
  const out = lines.map((l) => sanitizer.line(l))
  return { text: `${out.join('\n')}${trailing !== undefined ? '\n' : ''}`, sanitizer }
}

export function sanitizeTranscriptLine(text: string, options: SanitizeOptions): string {
  return createSanitizer(options).line(text)
}
