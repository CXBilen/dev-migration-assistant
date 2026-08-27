/**
 * Per-user UI preferences persisted in localStorage. Nothing here is sensitive; every read
 * is guarded because localStorage may be unavailable (e.g. strict sandboxes).
 */
const KEY_PREFIX = 'devmig.'

export const PREF_SHOW_EPHEMERAL = 'showEphemeral'

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function readBoolPref(name: string, fallback: boolean): boolean {
  const s = storage()
  if (!s) return fallback
  try {
    const raw = s.getItem(KEY_PREFIX + name)
    if (raw === null) return fallback
    return raw === 'true'
  } catch {
    return fallback
  }
}

export function writeBoolPref(name: string, value: boolean): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(KEY_PREFIX + name, value ? 'true' : 'false')
  } catch {
    /* ignore quota / privacy mode errors */
  }
}
