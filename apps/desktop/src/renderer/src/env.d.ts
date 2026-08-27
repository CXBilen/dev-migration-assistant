/// <reference types="vite/client" />
import type { DevMigrationApi } from '@devmig/ipc-contracts'

declare global {
  interface Window {
    devMigration: DevMigrationApi
  }
}
export {}
