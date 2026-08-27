import { useCallback, useState } from 'react'
import { PREF_SHOW_EPHEMERAL, readBoolPref, writeBoolPref } from '../lib/prefs'

export function useShowEphemeral(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readBoolPref(PREF_SHOW_EPHEMERAL, false))
  const update = useCallback((next: boolean) => {
    writeBoolPref(PREF_SHOW_EPHEMERAL, next)
    setValue(next)
  }, [])
  return [value, update]
}
