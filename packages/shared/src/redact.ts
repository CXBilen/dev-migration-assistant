/**
 * Reusable secret-redaction utility used by logging, diagnostics and error serialization.
 * Conservative by design: false positives (over-redaction) are acceptable; leaks are not.
 */

const SENSITIVE_WORDS = new Set([
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'passwd',
  'pwd',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'oauth',
  'apikey',
  'privatekey',
  'accesskey',
  'sessionkey',
  'secretkey',
  'signingkey',
  'encryptionkey',
  'clientsecret',
  'refreshtoken',
  'accesstoken',
  'idtoken',
  'oauthaccount',
])

/** Splits camelCase / snake_case / kebab-case keys into lowercase words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const VALUE_PATTERNS: RegExp[] = [
  // Authorization headers first, so the generic rule below cannot strand a token after the scheme word
  /(\bBearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
  /(\bBasic\s+)[A-Za-z0-9+/]+=*/gi,
  // Generic KEY=VALUE / "key": "value" assignments for sensitive-looking keys
  /((?:api[_-]?key|secret|token|password|passwd|pwd|authorization|access[_-]?key|client[_-]?secret|refresh[_-]?token|private[_-]?key|session[_-]?key)[a-z0-9_-]*["']?\s*[=:]\s*["']?)(?!(?:bearer|basic)\b)([^\s"',;]{4,})/gi,
  // Known token shapes
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, // Anthropic / OpenAI style
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bnpm_[A-Za-z0-9]{30,}\b/g, // npm tokens
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /\bsbp_[A-Za-z0-9]{20,}\b/g, // Supabase PAT
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export const REDACTED = '[REDACTED]'

export function redactSecrets(input: string): string {
  if (!input) return input
  let out = input
  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, (match, prefix?: string) =>
      typeof prefix === 'string' && prefix.length < match.length
        ? `${prefix}${REDACTED}`
        : REDACTED,
    )
  }
  return out
}

/** Returns true when an object key name looks like it holds a secret (word-aware: DEMO_TOKEN, refreshToken, api-key…). */
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key)
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true
  for (let i = 0; i < words.length - 1; i += 1) {
    if (SENSITIVE_WORDS.has(`${words[i]}${words[i + 1]}`)) return true
  }
  return false
}

/** Deep-clones a JSON-like value, redacting values of sensitive keys and secret-looking strings. */
export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 32) return value
  if (typeof value === 'string') return redactSecrets(value) as T
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1) as unknown) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        isSensitiveKey(k) && v !== null && v !== undefined && typeof v !== 'object'
          ? REDACTED
          : redactObject(v, depth + 1)
    }
    return out as T
  }
  return value
}
