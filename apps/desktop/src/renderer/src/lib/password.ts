export const MIN_PASSWORD_LENGTH = 8

export interface PasswordStrength {
  /** 0 = unusable, 1 = weak, 2 = fair, 3 = good, 4 = strong */
  score: 0 | 1 | 2 | 3 | 4
  label: string
  /** Meets the minimum the backup format requires. */
  acceptable: boolean
}

/** Cheap, offline strength estimate — length matters most; character variety adds a little. */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0)
    return { score: 0, label: `At least ${MIN_PASSWORD_LENGTH} characters`, acceptable: false }
  if (password.length < MIN_PASSWORD_LENGTH)
    return {
      score: 0,
      label: `${MIN_PASSWORD_LENGTH - password.length} more character${MIN_PASSWORD_LENGTH - password.length === 1 ? '' : 's'} needed`,
      acceptable: false,
    }
  let variety = 0
  if (/[a-z]/.test(password)) variety += 1
  if (/[A-Z]/.test(password)) variety += 1
  if (/[0-9]/.test(password)) variety += 1
  if (/[^A-Za-z0-9]/.test(password)) variety += 1
  const unique = new Set(password).size
  let score = 1
  if (password.length >= 12 || (password.length >= 10 && variety >= 3)) score = 2
  if (password.length >= 16 || (password.length >= 12 && variety >= 3)) score = 3
  if (password.length >= 20 || (password.length >= 16 && variety >= 3)) score = 4
  if (unique <= 3) score = 1
  const labels: Record<number, string> = { 1: 'Weak', 2: 'Fair', 3: 'Good', 4: 'Strong' }
  return { score: score as 1 | 2 | 3 | 4, label: labels[score] ?? 'Weak', acceptable: true }
}
