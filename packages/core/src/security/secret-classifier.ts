/**
 * Secret classification for files, buffers and JSON values. Conservative by design: over-classifying
 * as sensitive only costs the user an explicit opt-in; under-classifying leaks credentials.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Sensitivity } from '@devmig/model'
import { isSensitiveKey } from '@devmig/shared'

export const DEFAULT_CONTENT_SNIFF_BYTES = 256 * 1024

export interface PathClassification {
  sensitivity: Sensitivity
  reasons: string[]
}

export interface ContentClassification extends PathClassification {
  matches: number
}

export interface FileClassification extends ContentClassification {
  /** True when the file content was inspected (text-like and within the size budget). */
  contentInspected: boolean
}

export interface ClassifyContentOptions {
  /** Only the first maxBytes are inspected. */
  maxBytes?: number
}

const ENV_EXAMPLE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.defaults', '.schema']

const CREDENTIAL_FILE_RULES: { test: (name: string) => boolean; reason: string }[] = [
  {
    test: (n) => /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/.test(n) && !n.endsWith('.pub'),
    reason: 'SSH private key',
  },
  { test: (n) => n.endsWith('.pem'), reason: 'PEM key/certificate file' },
  { test: (n) => n.endsWith('.key'), reason: 'Private key file' },
  { test: (n) => n.endsWith('.p12') || n.endsWith('.pfx'), reason: 'PKCS#12 keystore' },
  { test: (n) => n === '.netrc' || n === '_netrc', reason: 'netrc credentials' },
  {
    test: (n) => n === 'credentials.json' || n === '.credentials.json',
    reason: 'Credentials file',
  },
  {
    test: (n) => n.endsWith('.keychain') || n.endsWith('.keychain-db'),
    reason: 'Keychain database',
  },
]

const SENSITIVE_FILE_RULES: { test: (name: string) => boolean; reason: string }[] = [
  { test: (n) => n === '.env', reason: 'Environment file' },
  {
    test: (n) => n.startsWith('.env.') && !ENV_EXAMPLE_SUFFIXES.some((s) => n.endsWith(s)),
    reason: 'Environment file variant',
  },
  { test: (n) => n === '.envrc', reason: 'direnv file may export secrets' },
  { test: (n) => n.endsWith('.secret') || n.endsWith('.secrets'), reason: 'Secret file' },
  {
    test: (n) => n === 'docker-compose.override.yml' || n === 'docker-compose.override.yaml',
    reason: 'Compose override often carries local credentials',
  },
  {
    test: (n) => n === '.yarnrc.yml' || n === '.yarnrc',
    reason: 'Yarn config may contain npm auth tokens',
  },
  { test: (n) => n === '.pypirc', reason: 'PyPI credentials' },
  { test: (n) => n === '.npmrc', reason: 'npm config may contain auth tokens' },
  {
    test: (n) =>
      /(token|secret|password|passwd|credential)/i.test(n) &&
      /(\.json|\.ya?ml|\.toml|\.ini|\.cfg|\.conf|\.config|\.txt|rc)$/i.test(n),
    reason: 'Config file name suggests secrets',
  },
  {
    test: (n) => /^(config|settings)\..*(token|secret)/i.test(n),
    reason: 'Config file name suggests secrets',
  },
]

/** Classifies a path from its file name alone (no I/O). */
export function classifyPath(relativeOrAbsPath: string): PathClassification {
  const name = path.basename(relativeOrAbsPath.replace(/[\\/]+$/, '')).normalize('NFC')
  const lower = name.toLowerCase()
  const reasons: string[] = []
  for (const rule of CREDENTIAL_FILE_RULES) {
    if (rule.test(lower)) reasons.push(rule.reason)
  }
  if (reasons.length > 0) return { sensitivity: 'credential', reasons }
  for (const rule of SENSITIVE_FILE_RULES) {
    if (rule.test(lower)) reasons.push(rule.reason)
  }
  // Well-known directories holding secrets
  const segments = relativeOrAbsPath.split(/[\\/]/).map((s) => s.toLowerCase())
  if (
    segments.includes('.ssh') &&
    !lower.endsWith('.pub') &&
    lower !== 'config' &&
    lower !== 'known_hosts'
  ) {
    return { sensitivity: 'credential', reasons: ['Inside an .ssh directory'] }
  }
  if (segments.includes('.aws') && lower === 'credentials') {
    return { sensitivity: 'credential', reasons: ['AWS credentials file'] }
  }
  if (reasons.length > 0) return { sensitivity: 'sensitive', reasons: [...new Set(reasons)] }
  return { sensitivity: 'safe', reasons: [] }
}

interface ContentRule {
  re: RegExp
  reason: string
  sensitivity: Sensitivity
}

const CONTENT_RULES: ContentRule[] = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    reason: 'Private key block',
    sensitivity: 'credential',
  },
  {
    // .npmrc / .yarnrc registry auth lines: //registry.npmjs.org/:_authToken=...
    re: /^\s*\/\/[^\s]+:_(?:authToken|auth|password)\s*=\s*(\S+)/gm,
    reason: 'Registry auth line',
    sensitivity: 'credential',
  },
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, reason: 'API key (sk-…)', sensitivity: 'sensitive' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, reason: 'GitHub token', sensitivity: 'sensitive' },
  {
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    reason: 'GitHub fine-grained token',
    sensitivity: 'sensitive',
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, reason: 'AWS access key id', sensitivity: 'sensitive' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, reason: 'Slack token', sensitivity: 'sensitive' },
  { re: /\bnpm_[A-Za-z0-9]{30,}\b/g, reason: 'npm token', sensitivity: 'sensitive' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, reason: 'Google API key', sensitivity: 'sensitive' },
  { re: /\bsbp_[A-Za-z0-9]{20,}\b/g, reason: 'Supabase token', sensitivity: 'sensitive' },
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    reason: 'JWT',
    sensitivity: 'sensitive',
  },
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g, reason: 'Bearer token', sensitivity: 'sensitive' },
  {
    // KEY=VALUE / KEY: VALUE / "key": "value" with a secret-looking key and a non-placeholder value
    re: /(?:^|[\s"'{,;])(?:[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret|refresh[_-]?token|private[_-]?key|session[_-]?key|auth)[A-Za-z0-9_-]*)["']?\s*[=:]\s*["']?([^\s"',;]{4,})/gi,
    reason: 'Secret-looking assignment',
    sensitivity: 'sensitive',
  },
  {
    re: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@[^\s/]+/g,
    reason: 'URL with embedded credentials',
    sensitivity: 'sensitive',
  },
]

const PLACEHOLDER_VALUE =
  /^(?:\$\{?[A-Z0-9_]+\}?|<[^>]*>|x{4,}|\*{3,}|your[-_]?[a-z_-]*|changeme|change_me|placeholder|example|redacted|null|undefined|none|true|false|\d{1,3}|[\^~<>=]*v?\d+(?:\.[\dx*]+)*)$/i
/** Values that are obviously code (a call or member access), not a literal secret. */
const CODE_VALUE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/

function rank(s: Sensitivity): number {
  return s === 'credential' ? 2 : s === 'sensitive' ? 1 : 0
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192))
  if (sample.includes(0)) return true
  let control = 0
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) control += 1
  }
  return sample.length > 0 && control / sample.length > 0.1
}

/** Scans (the first maxBytes of) a text buffer for secret-shaped content. */
export function classifyContent(
  input: Buffer | string,
  options: ClassifyContentOptions = {},
): ContentClassification {
  const maxBytes = options.maxBytes ?? DEFAULT_CONTENT_SNIFF_BYTES
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf
  if (isBinary(slice)) return { sensitivity: 'safe', reasons: [], matches: 0 }
  const text = slice.toString('utf8')
  let sensitivity: Sensitivity = 'safe'
  const reasons = new Set<string>()
  let matches = 0
  for (const rule of CONTENT_RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(text)) !== null) {
      const value = m[1]
      if (value !== undefined && (PLACEHOLDER_VALUE.test(value) || CODE_VALUE.test(value))) continue
      matches += 1
      reasons.add(rule.reason)
      if (rank(rule.sensitivity) > rank(sensitivity)) sensitivity = rule.sensitivity
      if (m[0].length === 0) rule.re.lastIndex += 1
    }
  }
  return { sensitivity, reasons: [...reasons], matches }
}

export interface ClassifyFileOptions extends ClassifyContentOptions {
  signal?: AbortSignal
}

/** Combines the filename rules with a bounded content sniff (files ≤ maxBytes, text-like). */
export async function classifyFile(
  absPath: string,
  options: ClassifyFileOptions = {},
): Promise<FileClassification> {
  const maxBytes = options.maxBytes ?? DEFAULT_CONTENT_SNIFF_BYTES
  const byPath = classifyPath(absPath)
  let content: ContentClassification = { sensitivity: 'safe', reasons: [], matches: 0 }
  let contentInspected = false
  try {
    const stat = await fs.stat(absPath)
    if (stat.isFile() && stat.size <= maxBytes) {
      const handle = await fs.open(absPath, 'r')
      try {
        const buf = Buffer.alloc(Math.min(stat.size, maxBytes))
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        const data = buf.subarray(0, bytesRead)
        if (!isBinary(data)) {
          content = classifyContent(data, { maxBytes })
          contentInspected = true
        }
      } finally {
        await handle.close()
      }
    }
  } catch {
    // unreadable files are classified by name only
  }
  const sensitivity =
    rank(content.sensitivity) > rank(byPath.sensitivity) ? content.sensitivity : byPath.sensitivity
  return {
    sensitivity,
    reasons: [...new Set([...byPath.reasons, ...content.reasons])],
    matches: content.matches,
    contentInspected,
  }
}

export interface JsonSecretHit {
  /** JSON pointer-like path, e.g. `mcpServers.github.env.GITHUB_TOKEN`. */
  path: string
  reason: string
}

const SECRET_CONTAINER_KEYS = /^(env|headers|environment|secrets|credentials|auth)$/i

/** Lists JSON paths whose keys look like secrets (env blocks, headers, tokens) or whose string values match token shapes. */
export function classifyJsonValue(value: unknown, basePath = ''): JsonSecretHit[] {
  const hits: JsonSecretHit[] = []
  const visit = (v: unknown, p: string, insideContainer: boolean, depth: number): void => {
    if (depth > 64) return
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${p}[${i}]`, insideContainer, depth + 1))
      return
    }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        const childPath = p ? `${p}.${k}` : k
        const container = SECRET_CONTAINER_KEYS.test(k)
        if (isSensitiveKey(k) && child !== null && typeof child !== 'object') {
          hits.push({ path: childPath, reason: `Key "${k}" looks like a secret` })
          continue
        }
        if (container && child && typeof child === 'object' && !Array.isArray(child)) {
          for (const [ck, cv] of Object.entries(child as Record<string, unknown>)) {
            const leafPath = `${childPath}.${ck}`
            if (cv !== null && typeof cv !== 'object') {
              if (isSensitiveKey(ck)) {
                hits.push({
                  path: leafPath,
                  reason: `Key "${ck}" in ${k} block looks like a secret`,
                })
              } else if (typeof cv === 'string' && classifyContent(cv).matches > 0) {
                hits.push({ path: leafPath, reason: `Value in ${k} block looks like a token` })
              }
            } else {
              visit(cv, leafPath, true, depth + 2)
            }
          }
          continue
        }
        visit(child, childPath, insideContainer || container, depth + 1)
      }
      return
    }
    if (typeof v === 'string') {
      const c = classifyContent(v)
      if (c.matches > 0) hits.push({ path: p, reason: c.reasons.join(', ') })
    }
  }
  visit(value, basePath, false, 0)
  return hits
}
