/**
 * Preload (sandboxed, single CJS bundle). Exposes exactly `window.devMigration` — a fixed set of
 * per-channel functions built in ./api.ts. Never exposes ipcRenderer, Node or the event objects.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { createDevMigrationApi, readPreloadMeta } from './api'

const api = createDevMigrationApi(ipcRenderer, readPreloadMeta(process.argv, process.platform))

contextBridge.exposeInMainWorld('devMigration', api)
