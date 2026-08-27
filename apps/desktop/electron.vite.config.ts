import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Workspace packages are consumed from TypeScript source, so they must be bundled (not externalized).
const workspacePackages = [
  '@devmig/archive',
  '@devmig/core',
  '@devmig/ipc-contracts',
  '@devmig/model',
  '@devmig/provider-claude-code',
  '@devmig/provider-git',
  '@devmig/provider-project-files',
  '@devmig/provider-runtime',
  '@devmig/shared',
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts') } },
      sourcemap: true,
    },
    resolve: { alias: { '@main': resolve(import.meta.dirname, 'src/main') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
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
