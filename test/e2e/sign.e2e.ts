import { describe, expect, it } from 'vitest'

import { getLiveSession, runCli } from './helpers.js'

const LIVE_TIMEOUT_MS = 6 * 60 * 1_000
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD'

describe('sign.e2e', () => {
  it(
    'submits allowlisted calls and rejects non-allowlisted calls',
    async () => {
      const session = await getLiveSession()

      const allowedCalls = JSON.stringify([
        {
          data: '0x',
          to: session.allowlistTo,
          value: '0x0',
        },
      ])

      const allowedArgs = ['sign', '--json', '--calls', allowedCalls]

      const allowedResult = await runCli(allowedArgs, session.env, 180_000)

      expect(
        allowedResult.exitCode,
        `allowed sign failed.\nstdout:\n${allowedResult.stdout}\n\nstderr:\n${allowedResult.stderr}`,
      ).toBe(0)
      expect(allowedResult.payload?.ok).toBe(true)

      const allowedStatus = allowedResult.payload?.status
      expect(typeof allowedStatus).toBe('string')
      expect(typeof allowedResult.payload?.bundleId).toBe('string')
      const txHash = allowedResult.payload?.txHash
      expect(txHash === null || typeof txHash === 'string').toBe(true)
      if (allowedStatus === 'pending') {
        expect(txHash).toBeNull()
      }

      const disallowedTo = session.allowlistTo.toLowerCase() === ZERO_ADDRESS.toLowerCase()
        ? DEAD_ADDRESS
        : ZERO_ADDRESS

      const disallowedCalls = JSON.stringify([
        {
          data: '0x',
          to: disallowedTo,
          value: '0x0',
        },
      ])

      const disallowedArgs = ['sign', '--json', '--calls', disallowedCalls]

      const disallowedResult = await runCli(disallowedArgs, session.env)

      expect(disallowedResult.exitCode).not.toBe(0)
      expect(disallowedResult.payload?.ok).toBe(false)

      const error = disallowedResult.payload?.error as
        | {
            code?: string
            message?: string
          }
        | undefined

      expect(typeof error?.code).toBe('string')
      expect(typeof error?.message).toBe('string')
    },
    LIVE_TIMEOUT_MS,
  )
})
