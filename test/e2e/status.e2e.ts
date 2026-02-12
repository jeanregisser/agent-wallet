import { describe, expect, it } from 'vitest'

import { makeIsolatedEnv, runCli } from './helpers.js'

describe('status.e2e', () => {
  it('returns signer/account summary in json mode for a fresh config', async () => {
    const env = await makeIsolatedEnv()

    const result = await runCli(['status', '--json'], env)

    expect(result.exitCode).toBe(0)
    expect(result.payload?.ok).toBe(true)

    const account = result.payload?.account as { address?: string | null }
    expect(account.address).toBeNull()

    const signer = result.payload?.signer as { exists?: boolean }
    expect(signer.exists).toBe(false)

    const balances = result.payload?.balances as unknown[]
    expect(Array.isArray(balances)).toBe(true)
    expect(balances).toHaveLength(0)
  })
})
