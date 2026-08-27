/**
 * Reusable secret-redaction utility used by logging, diagnostics and error serialization.
 * Conservative by design: false positives (over-redaction) are acceptable; leaks are not.
 */

const KEY_PATTERN =
  /\b(api[_-]?key|secret|token|password|passwd|pwd|authorization|auth|bearer|cookie|session[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|oauth[a-z_]*)\b/i

const VALUE_PATTERNS: RegExp[] = [
  // Generic KEY=VALUE / "key": "value" assignments for sensitive-looking keys
  /((?:api[_-]?key|secret|token|password|passwd|pwd|authorization|access[_-]?key|client[_-]?secret|refresh[_-]?token|private[_-]?key|session[_-]?key)[a-z0-9_-]*\s*[=:]\s*["']?)([^\s"',;]{4,})/gi,
  // Authorization headers
  /(\bBearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
  /(\bBasic\s+)[A-Za-z0-9+/]+=*/gi,
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

/** Returns true when an object key name looks like it holds a secret. */
export function isSensitiveKey(key: string): boolean {
  return KEY_PATTERN.test(key)
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
