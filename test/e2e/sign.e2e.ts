import { describe, expect, it } from 'vitest'

import { makeIsolatedEnv, runCli } from './helpers.js'

describe('sign.e2e', () => {
  it('returns structured KEY_NOT_INITIALIZED when signer is not configured', async () => {
    const env = await makeIsolatedEnv()

    const result = await runCli(
      [
        'sign',
        '--json',
        '--calls',
        '[{"to":"0x0000000000000000000000000000000000000000","data":"0x","value":"0x0"}]',
      ],
      env,
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.payload?.ok).toBe(false)

    const error = result.payload?.error as { code?: string; message?: string }
    expect(error.code).toBe('KEY_NOT_INITIALIZED')
    expect(error.message).toContain('agent-wallet configure')
  })
})
