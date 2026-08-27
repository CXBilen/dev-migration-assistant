import { useEffect, useState } from 'react'
import { getApi } from '../api'
import { log } from '../lib/log'

let cached: { homeDir: string; defaultProjectsDir: string } | null = null
let inflight: Promise<{ homeDir: string; defaultProjectsDir: string }> | null = null

function load(): Promise<{ homeDir: string; defaultProjectsDir: string }> {
  if (cached) return Promise.resolve(cached)
  inflight ??= getApi()
    .system.homeDir()
    .then((v) => {
      cached = v
      return v
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Home directory of the current user (for ~ abbreviation). Null until known. */
export function useHomeDir(): { homeDir: string | null; defaultProjectsDir: string | null } {
  const [value, setValue] = useState(cached)
  useEffect(() => {
    if (cached) return
    let active = true
    load()
      .then((v) => {
        if (active) setValue(v)
      })
      .catch((err: unknown) => log.warn('homeDir lookup failed', { err: String(err) }))
    return () => {
      active = false
    }
  }, [])
  return { homeDir: value?.homeDir ?? null, defaultProjectsDir: value?.defaultProjectsDir ?? null }
}

/** Test seam. */
export function resetHomeDirCache(): void {
  cached = null
  inflight = null
}
