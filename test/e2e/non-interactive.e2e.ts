import { describe, expect, it } from 'vitest'

import { makeIsolatedEnv, runCli } from './helpers.js'

describe('non-interactive.e2e', () => {
  it('fails fast with actionable error in human mode', async () => {
    const env = await makeIsolatedEnv()

    const result = await runCli(['configure', '--human'], env)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('NON_INTERACTIVE_REQUIRES_FLAGS')
    expect(result.stderr).toContain('--headless')
  })
})
