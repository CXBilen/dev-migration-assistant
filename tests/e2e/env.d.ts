/** The preload bridge as seen from `page.evaluate` callbacks (typed like the renderer's env.d.ts). */
import type { DevMigrationApi } from '../../packages/ipc-contracts/src/index'

declare global {
  interface Window {
    devMigration: DevMigrationApi
  }
}
export {}
