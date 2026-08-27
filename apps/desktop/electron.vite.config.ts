import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'

// Everything (workspace packages AND npm runtime deps such as tar, hash-wasm, execa, zod, electron-log) is bundled
// into out/, so the packaged app carries no node_modules. Only `electron` itself stays external (electron-vite default).
export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts') } },
      sourcemap: true,
    },
    resolve: { alias: { '@main': resolve(import.meta.dirname, 'src/main') } },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        // Sandboxed preloads must be a single CommonJS file (no ESM imports at runtime).
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
      sourcemap: true,
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@renderer': resolve(import.meta.dirname, 'src/renderer/src') } },
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
      sourcemap: true,
    },
  },
})
