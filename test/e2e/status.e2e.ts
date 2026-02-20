import { describe, expect, it } from 'vitest'

import { getLiveSession, runCli } from './helpers.js'

const LIVE_TIMEOUT_MS = 4 * 60 * 1_000

describe('status.e2e', () => {
  it(
    'returns full status in json and human modes after configure',
    async () => {
      const session = await getLiveSession()

      const jsonResult = await runCli(['status', '--json'], session.env)
      expect(jsonResult.exitCode).toBe(0)
      expect(jsonResult.payload?.ok).toBe(true)

      const account = jsonResult.payload?.account as
        | {
            address?: string | null
            chainId?: number | null
          }
        | undefined

      expect(account?.address?.toLowerCase()).toBe(session.accountAddress.toLowerCase())
      expect(account?.chainId).toBe(session.chainId)

      const signer = jsonResult.payload?.signer as
        | {
            backend?: string
            exists?: boolean
          }
        | undefined

      expect(signer?.backend).toBe('secure-enclave')
      expect(signer?.exists).toBe(true)

      const permissions = jsonResult.payload?.permissions as
        | {
            active?: number
            total?: number
          }
        | undefined

      expect(typeof permissions?.active).toBe('number')
      expect(typeof permissions?.total).toBe('number')
      expect((permissions?.total ?? 0) >= (permissions?.active ?? 0)).toBe(true)

      const activation = jsonResult.payload?.activation as
        | {
            state?: string
          }
        | undefined
      expect(['active_onchain', 'pending_activation', 'unconfigured']).toContain(activation?.state)

      const humanResult = await runCli(['status', '--human'], session.env)
      expect(humanResult.exitCode).toBe(0)
      expect(humanResult.stdout).toContain('Status')
      expect(humanResult.stdout).toContain('Activation:')
      expect(humanResult.stdout.toLowerCase()).toContain(session.accountAddress.toLowerCase())
    },
    LIVE_TIMEOUT_MS,
  )
})
