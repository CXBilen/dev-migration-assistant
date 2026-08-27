// Preload bridge — the full typed API lands with the Electron main-process wiring. Never expose ipcRenderer directly.
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('devMigration', {
  meta: { appVersion: '0.1.0-alpha.4', platform: process.platform, isE2E: false },
})
