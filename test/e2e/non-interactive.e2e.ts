import { describe, expect, it } from 'vitest'

import { getLiveSession, runCli } from './helpers.js'

describe('non-interactive.e2e', () => {
  it('fails fast with actionable structured error when --headless is omitted', async () => {
    const session = await getLiveSession()

    const result = await runCli(
      [
        'configure',
        '--create-account',
        '--calls',
        '[{"to":"0x0000000000000000000000000000000000000000"}]',
      ],
      session.env,
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('NON_INTERACTIVE_REQUIRES_FLAGS')
    expect(result.stderr).toContain('--headless')
    expect(result.stderr).toContain('"checkpoint": "account"')
  })
})
