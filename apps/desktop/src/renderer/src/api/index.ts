/**
 * Single entry point for everything the renderer asks of the outside world.
 *
 * `getApi()` returns the preload bridge (`window.devMigration`) when it is complete, and
 * otherwise a deterministic in-memory mock so the UI can be developed with `electron-vite dev`
 * before the bridge exists and so component tests never depend on timers in the main process.
 */
import type { DevMigrationApi } from '@devmig/ipc-contracts'
import { createMockApi } from './mock-api'

let override: DevMigrationApi | null = null
let mock: DevMigrationApi | null = null

function isCompleteBridge(candidate: unknown): candidate is DevMigrationApi {
  if (!candidate || typeof candidate !== 'object') return false
  const api = candidate as Partial<DevMigrationApi>
  return (
    typeof api.projects?.scan === 'function' &&
    typeof api.backups?.create === 'function' &&
    typeof api.restore?.plan === 'function' &&
    typeof api.jobs?.onProgress === 'function' &&
    typeof api.system?.diagnostics === 'function'
  )
}

export function getApi(): DevMigrationApi {
  if (override) return override
  if (typeof window !== 'undefined') {
    const bridge: unknown = (window as { devMigration?: unknown }).devMigration
    if (isCompleteBridge(bridge)) return bridge
  }
  mock ??= createMockApi()
  return mock
}

/** True when the UI is running against the in-memory mock rather than the Electron bridge. */
export function isMockApi(): boolean {
  return getApi() === mock
}

/** Test seam: inject an API implementation (pass null to restore the default resolution). */
export function setApiForTests(api: DevMigrationApi | null): void {
  override = api
}
