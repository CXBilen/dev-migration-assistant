import { describe, expect, it } from 'vitest'
import { isSensitiveKey, redactObject, redactSecrets, REDACTED } from './redact'

describe('redactSecrets', () => {
  it('redacts known token shapes', () => {
    const samples = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_abcdefghijklmnopqrstuvwxyz0123',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghijk',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'AIzaSyA-abcdefghijklmnopqrstuvwxyz012345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnopqrstuvwxyz',
    ]
    for (const s of samples) {
      const out = redactSecrets(`value: ${s} end`)
      expect(out).not.toContain(s)
      expect(out).toContain(REDACTED)
    }
  })

  it('redacts key=value assignments and headers but keeps keys', () => {
    expect(redactSecrets('API_KEY=supersecretvalue')).toBe(`API_KEY=${REDACTED}`)
    expect(redactSecrets('"password": "hunter22"')).toContain(`"password": "${REDACTED}`)
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    )
    expect(redactSecrets('authorization=Basic dXNlcjpwYXNz')).toBe(
      `authorization=Basic ${REDACTED}`,
    )
    expect(redactSecrets('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toBe(
      REDACTED,
    )
  })

  it('keeps numeric values under token-ish keys', () => {
    expect(redactSecrets('{"cache_creation_input_tokens":37082}')).toBe(
      '{"cache_creation_input_tokens":37082}',
    )
    expect(redactSecrets('input_tokens: 1234, output_tokens=5')).toBe(
      'input_tokens: 1234, output_tokens=5',
    )
  })

  it('leaves ordinary text and paths alone', () => {
    const text = 'Restored /Users/alice/Documents/GitHub/demo with 187 sessions on branch main'
    expect(redactSecrets(text)).toBe(text)
    expect(redactSecrets('')).toBe('')
  })

  it('redactObject masks sensitive keys and nested strings', () => {
    const out = redactObject({
      token: 'abc',
      nested: { apiKey: 'x', note: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', ok: 1 },
      list: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      env: { DEMO_TOKEN: 'tok', PATH: '/usr/bin' },
    })
    expect(out.token).toBe(REDACTED)
    expect(out.nested.apiKey).toBe(REDACTED)
    expect(out.nested.note).toBe(REDACTED)
    expect(out.nested.ok).toBe(1)
    expect(out.list[0]).toBe(REDACTED)
    expect(out.env.DEMO_TOKEN).toBe(REDACTED)
    expect(out.env.PATH).toBe('/usr/bin')
    expect(isSensitiveKey('refreshToken')).toBe(true)
    expect(isSensitiveKey('cwd')).toBe(false)
  })
})
