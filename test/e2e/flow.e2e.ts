import { describe, expect, it, onTestFinished } from 'vitest'

import {
  buildConfigureArgs,
  ensureAccountFunding,
  extractDialogUrl,
  getLiveNetwork,
  launchVirtualBrowser,
  makeIsolatedEnv,
  readAgentWalletConfig,
  runCli,
  spawnCli,
} from './helpers.js'

const FLOW_TIMEOUT_MS = 10 * 60 * 1_000
const DIALOG_URL_PATTERN = /https?:\/\/\S+\/dialog\S*relayUrl=/
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

describe('e2e flow', () => {
  it(
    'configure → sign → status → idempotent rerun',
    async () => {
      const env = await makeIsolatedEnv()
      const network = getLiveNetwork()
      const allowlistTo = (process.env.AGENT_WALLET_E2E_ALLOWLIST_TO ?? DEAD_ADDRESS) as `0x${string}`
      const dialogHost = process.env.AGENT_WALLET_E2E_DIALOG_HOST

      const browser = await launchVirtualBrowser()
      onTestFinished(() => browser.close())
      const { page } = browser

      // ── Configure: create account + grant permissions ───────────────────────

      const configure = spawnCli(
        buildConfigureArgs({ allowlistTo, createAccount: true, dialogHost, mode: 'human', network }),
        env.env,
      )

      const configureDialogLine = await configure.waitFor(DIALOG_URL_PATTERN, 60_000)
      await page.goto(extractDialogUrl(configureDialogLine)!, { waitUntil: 'domcontentloaded' })

      // wallet_connect (createAccount): sign-up triggers the passkey ceremony;
      // WebAuthn virtual authenticator auto-responds.
      await page.getByTestId('sign-up').click()
      // wallet_connect (selectAccount): the grant step authenticates the account first.
      await page.getByTestId('sign-in').click()
      // wallet_grantPermissions: faucet may appear on testnet before the grant button.
      const faucetBtn = page.getByTestId('add-faucet-funds')
      if (await faucetBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await faucetBtn.click()
      }
      await page.getByTestId('grant').click()

      const configureResult = await configure.done()
      expect(
        configureResult.exitCode,
        `configure failed:\nstdout: ${configureResult.stdout}\nstderr: ${configureResult.stderr}`,
      ).toBe(0)
      expect(configureResult.stdout).toContain('Configure complete')

      // ── Get account details ───────────────────────────────────────────────

      const statusCheck = await runCli(['status', '--json'], env.env)
      expect(statusCheck.payload?.ok).toBe(true)
      const account = statusCheck.payload?.account as { address: `0x${string}`; chainId: number }

      // ── Fund account for signing tests (testnet only) ─────────────────────

      await ensureAccountFunding({ accountAddress: account.address, chainId: account.chainId, network })

      // ── Sign an allowed call ──────────────────────────────────────────────

      const allowedResult = await runCli(
        ['sign', '--json', '--calls', JSON.stringify([{ data: '0x', to: allowlistTo, value: '0x0' }])],
        env.env,
        180_000,
      )
      expect(
        allowedResult.exitCode,
        `allowed sign failed:\nstdout: ${allowedResult.stdout}\nstderr: ${allowedResult.stderr}`,
      ).toBe(0)
      expect(allowedResult.payload?.ok).toBe(true)
      expect(typeof allowedResult.payload?.bundleId).toBe('string')
      const txHash = allowedResult.payload?.txHash
      expect(txHash === null || typeof txHash === 'string').toBe(true)

      // ── Reject a disallowed call ──────────────────────────────────────────

      const disallowedTo = allowlistTo.toLowerCase() === ZERO_ADDRESS ? DEAD_ADDRESS : ZERO_ADDRESS
      const disallowedResult = await runCli(
        ['sign', '--json', '--calls', JSON.stringify([{ data: '0x', to: disallowedTo, value: '0x0' }])],
        env.env,
      )
      expect(disallowedResult.exitCode).not.toBe(0)
      expect(disallowedResult.payload?.ok).toBe(false)
      const error = disallowedResult.payload?.error as { code?: string; message?: string } | undefined
      expect(typeof error?.code).toBe('string')
      expect(typeof error?.message).toBe('string')

      // ── Status: verify full state in json and human modes ─────────────────

      const jsonStatus = await runCli(['status', '--json'], env.env)
      expect(jsonStatus.exitCode).toBe(0)
      expect(jsonStatus.payload?.ok).toBe(true)

      const statusAccount = jsonStatus.payload?.account as { address: string; chainId: number }
      expect(statusAccount?.address?.toLowerCase()).toBe(account.address.toLowerCase())
      expect(statusAccount?.chainId).toBe(account.chainId)

      const signer = jsonStatus.payload?.signer as { backend?: string; exists?: boolean } | undefined
      expect(signer?.backend).toBe('secure-enclave')
      expect(signer?.exists).toBe(true)

      const permissions = jsonStatus.payload?.permissions as { active?: number; total?: number } | undefined
      expect(typeof permissions?.active).toBe('number')
      expect(typeof permissions?.total).toBe('number')
      expect((permissions?.total ?? 0) >= (permissions?.active ?? 0)).toBe(true)

      const activation = jsonStatus.payload?.activation as { state?: string } | undefined
      expect(['active_onchain', 'pending_activation', 'unconfigured']).toContain(activation?.state)

      const humanStatus = await runCli(['status', '--human'], env.env)
      expect(humanStatus.exitCode).toBe(0)
      expect(humanStatus.stdout).toContain('Status')
      expect(humanStatus.stdout).toContain('Activation:')
      expect(humanStatus.stdout.toLowerCase()).toContain(account.address.toLowerCase())

      // ── Rerun configure: verify idempotency ───────────────────────────────

      const rerun = spawnCli(
        buildConfigureArgs({ allowlistTo, dialogHost, mode: 'human', network }),
        env.env,
      )

      // A dialog may or may not appear on rerun depending on permission state
      const rerunDialogLine = await rerun.waitFor(DIALOG_URL_PATTERN, 15_000).catch(() => null)
      if (rerunDialogLine) {
        await page.goto(extractDialogUrl(rerunDialogLine)!, { waitUntil: 'domcontentloaded' })
        await page.getByTestId('sign-in').click()
        await page.getByTestId('grant').click()
      }

      const rerunResult = await rerun.done()
      expect(rerunResult.exitCode).toBe(0)
      expect(rerunResult.stdout).toContain('Configure complete')

      const checkpoints = parseCheckpoints(rerunResult.stdout)
      expect(checkpoints.get('account')).toBe('already_ok')
      expect(checkpoints.get('agent_key')).toBe('already_ok')
      expect(['already_ok', 'updated']).toContain(checkpoints.get('permission_state'))
      expect(['already_ok', 'updated']).toContain(checkpoints.get('permission_preparation'))
      expect(['already_ok', 'updated']).toContain(checkpoints.get('permission_classification'))
      expect(['already_ok', 'updated']).toContain(checkpoints.get('outcome'))

      // ── Verify persisted config ───────────────────────────────────────────

      const config = await readAgentWalletConfig(env.configHome)
      expect(config.porto?.address?.toLowerCase()).toBe(account.address.toLowerCase())
      const permissionIds = config.porto?.permissionIds ?? []
      expect(new Set(permissionIds).size).toBe(permissionIds.length)
    },
    FLOW_TIMEOUT_MS,
  )
})

function parseCheckpoints(stdout: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const match = /^-\s+([a-z_]+):\s+([a-z_]+)$/i.exec(line.trim())
    if (match?.[1] && match[2]) map.set(match[1], match[2])
  }
  return map
}
