import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['.tmp/**', 'node_modules/**', 'dist/**'],
  },
})
