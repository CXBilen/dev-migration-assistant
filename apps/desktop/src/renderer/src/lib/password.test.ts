import { describe, expect, it } from 'vitest'
import { passwordStrength } from './password'

describe('passwordStrength', () => {
  it('requires eight characters', () => {
    expect(passwordStrength('')).toMatchObject({ score: 0, acceptable: false })
    expect(passwordStrength('short')).toMatchObject({
      score: 0,
      acceptable: false,
      label: '3 more characters needed',
    })
    expect(passwordStrength('1234567')).toMatchObject({
      acceptable: false,
      label: '1 more character needed',
    })
    expect(passwordStrength('12345678')).toMatchObject({ acceptable: true })
  })
  it('scores length and variety', () => {
    expect(passwordStrength('aaaaaaaa').score).toBe(1)
    expect(passwordStrength('password').score).toBe(1)
    expect(passwordStrength('correct horse').score).toBe(2)
    expect(passwordStrength('correct horse battery').score).toBe(4)
    expect(passwordStrength('Tr0ub4dor&3xx').score).toBe(3)
    expect(passwordStrength('aaaaaaaaaaaaaaaaaaaaaaaa').score).toBe(1)
  })
})
