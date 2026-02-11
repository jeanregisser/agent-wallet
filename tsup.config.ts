import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/agent-wallet.ts', 'src/porto-wallet.ts'],
  format: ['esm'],
  target: 'node22',
  sourcemap: true,
  splitting: false,
  clean: true,
  outDir: 'dist',
  banner: {
    js: '#!/usr/bin/env node',
  },
})
