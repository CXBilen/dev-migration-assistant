import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/**/*.test.ts',
            'apps/desktop/src/main/**/*.test.ts',
            'apps/desktop/src/preload/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'renderer',
          include: ['apps/desktop/src/renderer/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**'],
          environment: 'jsdom',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 120_000,
          pool: 'forks',
        },
      },
    ],
  },
})
