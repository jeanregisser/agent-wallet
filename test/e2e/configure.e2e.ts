import { describe, expect, it } from 'vitest'

import { makeIsolatedEnv, runCli } from './helpers.js'

describe('configure.e2e', () => {
  it('emits checkpoint failure details for non-interactive bootstrap without --headless', async () => {
    const env = await makeIsolatedEnv()

    const result = await runCli(['configure', '--json'], env)

    expect(result.exitCode).not.toBe(0)
    expect(result.payload).toBeTruthy()
    expect(result.payload?.ok).toBe(false)

    const error = result.payload?.error as { code?: string; details?: Record<string, unknown> }
    expect(error.code).toBe('NON_INTERACTIVE_REQUIRES_FLAGS')
    expect(error.details?.checkpoint).toBe('account')

    const checkpoints = error.details?.checkpoints as Array<Record<string, unknown>>
    expect(checkpoints[0]?.checkpoint).toBe('account')
    expect(checkpoints[0]?.status).toBe('failed')
  })
})
