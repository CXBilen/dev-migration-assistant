// Preload bridge — full typed API lands in Phase 6. Never expose ipcRenderer directly.
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('devMigration', {
  meta: { appVersion: '0.1.0', platform: process.platform, isE2E: false },
})
