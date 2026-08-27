import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * Content-Security-Policy of the packaged renderer (docs/research/electron-security.md §3).
 * `src/renderer/index.html` carries a dev policy (it needs the Vite dev server for HMR); the built
 * page must not reference localhost at all. `style-src 'unsafe-inline'` stays because Radix primitives
 * set inline style attributes; scripts are never inline and never from data:/http(s):.
 */
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ')

const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i

function productionCsp(): Plugin {
  return {
    name: 'devmig-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const tag = `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`
      return CSP_META.test(html)
        ? html.replace(CSP_META, tag)
        : html.replace('<head>', `<head>\n    ${tag}`)
    },
  }
}

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
    plugins: [react(), tailwindcss(), productionCsp()],
    resolve: { alias: { '@renderer': resolve(import.meta.dirname, 'src/renderer/src') } },
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
      sourcemap: true,
    },
  },
})
