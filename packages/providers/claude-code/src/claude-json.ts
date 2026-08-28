/**
 * ~/.claude.json helpers (research §10, §11): extraction with MCP secrets stripped, add-only merges,
 * and the invariant that identity keys (oauthAccount, userID, machineID) are never written.
 */
import { classifyJsonValue } from '@devmig/core'
import { MigrationError, canonicalizePath } from '@devmig/shared'
import { CLAUDE_JSON_GLOBAL_CONFIG_KEYS, CLAUDE_JSON_IDENTITY_KEYS } from './constants'
import { readOptionalJson } from './fs-helpers'
import {
  ClaudeJsonProjectEntrySchema,
  ClaudeJsonSchema,
  McpServerSchema,
  type ClaudeJson,
  type JsonObject,
  type McpEnvMap,
} from './schema'

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reads and validates ~/.claude.json. Returns undefined when the file does not exist. */
export async function readClaudeJson(file: string): Promise<ClaudeJson | undefined> {
  const raw = await readOptionalJson(file)
  if (raw === undefined) return undefined
  const parsed = ClaudeJsonSchema.safeParse(raw)
  if (!parsed.success) {
    throw new MigrationError(
      'INVALID_INPUT',
      `${file} does not look like a Claude Code config file`,
      {
        details: { file, issues: parsed.error.issues.slice(0, 5).map((i) => i.message) },
      },
    )
  }
  return parsed.data
}

export interface StrippedServers {
  /** Servers without env/headers. */
  servers: Record<string, unknown>
  /** name -> { env, headers } for servers that had any. */
  secrets: Record<string, { env?: Record<string, unknown>; headers?: Record<string, unknown> }>
}

/** Splits MCP server definitions into a secret-free part and the env/headers blocks. */
export function stripMcpSecrets(servers: Record<string, unknown> | undefined): StrippedServers {
  const out: StrippedServers = { servers: {}, secrets: {} }
  if (!servers) return out
  for (const [name, definition] of Object.entries(servers)) {
    const parsed = McpServerSchema.safeParse(definition)
    if (!parsed.success || !isObject(definition)) {
      out.servers[name] = definition
      continue
    }
    const { env, headers, ...rest } = parsed.data
    out.servers[name] = rest
    const secret: { env?: Record<string, unknown>; headers?: Record<string, unknown> } = {}
    if (env && Object.keys(env).length > 0) secret.env = env
    if (headers && Object.keys(headers).length > 0) secret.headers = headers
    if (secret.env || secret.headers) out.secrets[name] = secret
  }
  return out
}

export interface McpSecretHit {
  server: string
  /** JSON path inside the server definition, e.g. `args[2]` or `url`. Never the value. */
  path: string
  reason: string
}

/**
 * Secret-looking values OUTSIDE env/headers (inline `API_KEY=…` args, `user:password@` urls). Such a
 * server definition cannot be split into a safe part and a secret part, so the whole artifact that
 * carries it must be classified sensitive (opt-in).
 */
export function findMcpSecretHits(servers: Record<string, unknown> | undefined): McpSecretHit[] {
  const hits: McpSecretHit[] = []
  if (!servers) return hits
  for (const [server, definition] of Object.entries(servers)) {
    if (!isObject(definition)) continue
    const { env: _env, headers: _headers, ...rest } = definition
    for (const hit of classifyJsonValue(rest))
      hits.push({ server, path: hit.path, reason: hit.reason })
  }
  return hits
}

/** Finds the key of `projects` that refers to `targetPath` (exact after canonicalization). */
export function findProjectEntryKey(
  projects: Record<string, unknown> | undefined,
  targetPath: string,
): string | undefined {
  if (!projects) return undefined
  const target = canonicalizePath(targetPath)
  return Object.keys(projects).find((k) => canonicalizePath(k) === target)
}

export interface ExtractedProjectEntries {
  /** path -> entry with env/headers removed from mcpServers. */
  projects: Record<string, JsonObject>
  /** path -> server -> { env, headers } (only when present). */
  mcpEnv: McpEnvMap
}

/** Extracts the entries for the given paths from `projects`, stripping MCP secrets. */
export function extractProjectEntries(
  json: ClaudeJson | undefined,
  paths: readonly string[],
): ExtractedProjectEntries {
  const result: ExtractedProjectEntries = { projects: {}, mcpEnv: {} }
  if (!json?.projects) return result
  for (const p of paths) {
    const key = findProjectEntryKey(json.projects, p)
    if (key === undefined) continue
    const raw = json.projects[key]
    const parsed = ClaudeJsonProjectEntrySchema.safeParse(raw)
    if (!parsed.success || !isObject(raw)) continue
    const { mcpServers, ...rest } = parsed.data
    const entry: JsonObject = { ...rest }
    if (mcpServers) {
      const stripped = stripMcpSecrets(mcpServers)
      entry.mcpServers = stripped.servers
      if (Object.keys(stripped.secrets).length > 0) result.mcpEnv[key] = stripped.secrets
    }
    result.projects[key] = entry
  }
  return result
}

export interface ExtractedUserScope {
  mcpServers: Record<string, unknown>
  mcpEnv: Record<string, { env?: Record<string, unknown>; headers?: Record<string, unknown> }>
  config: Record<string, unknown>
}

/** User-scope MCP servers (secrets stripped) and the global config keys of ~/.claude.json. */
export function extractUserScope(json: ClaudeJson | undefined): ExtractedUserScope {
  const stripped = stripMcpSecrets(json?.mcpServers)
  const config: Record<string, unknown> = {}
  if (json) {
    for (const key of CLAUDE_JSON_GLOBAL_CONFIG_KEYS) {
      if (Object.hasOwn(json, key) && json[key] !== undefined) config[key] = json[key]
    }
  }
  return { mcpServers: stripped.servers, mcpEnv: stripped.secrets, config }
}

/** Deep add-only merge: keys missing in `target` are copied from `source`; existing keys (incl. arrays) win. */
export function mergeAddOnly(
  target: JsonObject,
  source: JsonObject,
): { added: string[]; kept: string[] } {
  const added: string[] = []
  const kept: string[] = []
  const visit = (t: JsonObject, s: JsonObject, prefix: string): void => {
    for (const [key, value] of Object.entries(s)) {
      const label = prefix ? `${prefix}.${key}` : key
      if (!Object.hasOwn(t, key) || t[key] === undefined) {
        t[key] = structuredClone(value)
        added.push(label)
        continue
      }
      const existing = t[key]
      if (isObject(existing) && isObject(value)) {
        visit(existing, value, label)
      } else {
        kept.push(label)
      }
    }
  }
  visit(target, source, '')
  return { added, kept }
}

/** Re-attaches env/headers blocks to server definitions (add-only per key). */
export function applyMcpEnv(
  servers: Record<string, unknown>,
  secrets: Record<string, { env?: Record<string, unknown>; headers?: Record<string, unknown> }>,
): { applied: string[] } {
  const applied: string[] = []
  for (const [name, secret] of Object.entries(secrets)) {
    const target = servers[name]
    if (!isObject(target)) continue
    for (const block of ['env', 'headers'] as const) {
      const values = secret[block]
      if (!values) continue
      const existing = target[block]
      if (isObject(existing)) {
        for (const [k, v] of Object.entries(values)) {
          if (!Object.hasOwn(existing, k)) existing[k] = v
        }
      } else {
        target[block] = structuredClone(values)
      }
    }
    applied.push(name)
  }
  return { applied }
}

/** Removes identity keys from an object about to be written. Defensive: payloads never contain them. */
export function assertNoIdentityKeys(value: JsonObject, where: string): void {
  for (const key of CLAUDE_JSON_IDENTITY_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new MigrationError('INVALID_INPUT', `${where} must never contain ${key}`, {
        details: { where, key },
      })
    }
  }
}

export { isObject as isJsonObject }
