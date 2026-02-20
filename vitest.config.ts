import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    projects: [
      {
        test: {
          include: ['src/**/*.test.ts'],
          name: 'unit',
        },
      },
      {
        test: {
          fileParallelism: false,
          include: ['test/**/*.e2e.ts'],
          name: 'e2e',
          testTimeout: 4 * 60 * 1_000,
        },
      },
    ],
  },
})
