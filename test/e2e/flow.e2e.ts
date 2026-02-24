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

      // wallet_connect(createAccount + grantPermissions): sign-up triggers the passkey ceremony
      // and approves the permission grant in one step; WebAuthn virtual authenticator auto-responds.
      await page.getByTestId('sign-up').click()

      const configureResult = await configure.done()
      expect(
        configureResult.exitCode,
        `configure failed:\nstdout: ${configureResult.stdout}\nstderr: ${configureResult.stderr}`,
      ).toBe(0)
      expect(normalizeText(configureResult.stdout)).toMatchInlineSnapshot(`
        "

        Open the URL below in your browser to continue:

        https://id.porto.sh/dialog/?relayUrl=[dynamic]

        Configure complete
        Checkpoints:
        - agent_key: created
        - account: created
        Account: [dynamic]
        Chain ID: 84532
        Permission ID: [dynamic]
        "
      `)

      // ── Get account details ───────────────────────────────────────────────

      const statusCheck = await runCli(['status', '--json'], env.env)
      expect(statusCheck.exitCode).toBe(0)
      const account = statusCheck.payload?.account as { address: `0x${string}`; chainId: number }
      // After configure, precall is stored locally. The permission may already be
      // on-chain (createAccount submits a tx) or still precall-pending.
      expect(statusCheck.payload).toMatchInlineSnapshot({
        account: { address: expect.any(String) },
        activation: { state: expect.any(String) },
        balances: [{ address: expect.any(String), formatted: expect.any(String), wei: expect.any(String) }],
        permissions: {
          active: expect.any(Number),
          latestExpiry: expect.toSatisfy((v) => v === null || typeof v === 'string'),
          total: expect.any(Number),
        },
        precallPermissions: [{ expiry: expect.any(String), id: expect.any(String) }],
      }, `
        {
          "account": {
            "address": Any<String>,
            "chainId": 84532,
            "chainName": "Base Sepolia",
          },
          "activation": {
            "state": Any<String>,
          },
          "balances": [
            {
              "address": Any<String>,
              "chainId": 84532,
              "chainName": "Base Sepolia",
              "formatted": Any<String>,
              "symbol": "ETH",
              "wei": Any<String>,
            },
          ],
          "command": "status",
          "ok": true,
          "permissions": {
            "active": Any<Number>,
            "latestExpiry": toSatisfy<[Function anonymous]>,
            "total": Any<Number>,
          },
          "poweredBy": "Porto",
          "precallPermissions": [
            {
              "chainId": 84532,
              "expiry": Any<String>,
              "id": Any<String>,
            },
          ],
          "signer": {
            "backend": "secure-enclave",
            "curve": "p256",
            "exists": true,
            "keyId": "se.agent.wallet.default",
          },
          "warnings": [],
        }
      `)

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
      expect(allowedResult.payload).toMatchInlineSnapshot({
        bundleId: expect.any(String),
        txHash: expect.any(String),
      }, `
        {
          "bundleId": Any<String>,
          "command": "sign",
          "ok": true,
          "poweredBy": "Porto",
          "status": "success",
          "txHash": Any<String>,
        }
      `)

      // ── Reject a disallowed call ──────────────────────────────────────────

      const disallowedTo = allowlistTo.toLowerCase() === ZERO_ADDRESS ? DEAD_ADDRESS : ZERO_ADDRESS
      const disallowedResult = await runCli(
        ['sign', '--json', '--calls', JSON.stringify([{ data: '0x', to: disallowedTo, value: '0x0' }])],
        env.env,
      )
      expect(disallowedResult.exitCode).not.toBe(0)
      expect(disallowedResult.payload).toMatchInlineSnapshot({
        error: { message: expect.any(String), details: { details: expect.any(String), message: expect.any(String) } },
      }, `
        {
          "error": {
            "code": "PORTO_SEND_PREPARE_FAILED",
            "details": {
              "code": -32603,
              "details": Any<String>,
              "message": Any<String>,
              "name": "InternalRpcError",
              "shortMessage": "An internal error was received.",
              "stage": "prepare_calls",
            },
            "message": Any<String>,
          },
          "ok": false,
        }
      `)

      // ── Status: verify full state in json and human modes ─────────────────

      const jsonStatus = await runCli(['status', '--json'], env.env)
      expect(jsonStatus.exitCode).toBe(0)
      const statusAccount = jsonStatus.payload?.account as { address: string; chainId: number }
      expect(statusAccount?.address?.toLowerCase()).toBe(account.address.toLowerCase())
      expect(jsonStatus.payload).toMatchInlineSnapshot({
        account: { address: expect.any(String) },
        activation: { state: expect.any(String) },
        balances: [{ address: expect.any(String), formatted: expect.any(String), wei: expect.any(String) }],
        permissions: {
          active: expect.any(Number),
          latestExpiry: expect.toSatisfy((v) => v === null || typeof v === 'string'),
          total: expect.any(Number),
        },
      }, `
        {
          "account": {
            "address": Any<String>,
            "chainId": 84532,
            "chainName": "Base Sepolia",
          },
          "activation": {
            "state": Any<String>,
          },
          "balances": [
            {
              "address": Any<String>,
              "chainId": 84532,
              "chainName": "Base Sepolia",
              "formatted": Any<String>,
              "symbol": "ETH",
              "wei": Any<String>,
            },
          ],
          "command": "status",
          "ok": true,
          "permissions": {
            "active": Any<Number>,
            "latestExpiry": toSatisfy<[Function anonymous]>,
            "total": Any<Number>,
          },
          "poweredBy": "Porto",
          "precallPermissions": [],
          "signer": {
            "backend": "secure-enclave",
            "curve": "p256",
            "exists": true,
            "keyId": "se.agent.wallet.default",
          },
          "warnings": [],
        }
      `)

      const humanStatus = await runCli(['status', '--human'], env.env)
      expect(humanStatus.exitCode).toBe(0)
      expect(normalizeText(humanStatus.stdout)).toMatchInlineSnapshot(`
        "Status
        Account: [dynamic]
        Chain: Base Sepolia (84532)
        Signer: secure-enclave (ready)
        Activation: active_onchain
        Permissions: 1 active / 1 total
        Latest permission expiry: [dynamic]
        Balances:
        - [dynamic] ETH on Base Sepolia"
      `)

      // ── Rerun configure: verify idempotency ───────────────────────────────

      const rerun = spawnCli(
        buildConfigureArgs({ allowlistTo, dialogHost, mode: 'human', network }),
        env.env,
      )

      // A dialog may or may not appear on rerun depending on permission state
      const rerunDialogLine = await rerun.waitFor(DIALOG_URL_PATTERN, 15_000).catch(() => null)
      if (rerunDialogLine) {
        await page.goto(extractDialogUrl(rerunDialogLine)!, { waitUntil: 'domcontentloaded' })
        // wallet_connect(selectAccount + grantPermissions): one click handles sign-in and permission grant.
        await page.getByTestId('sign-in').click()
      }

      const rerunResult = await rerun.done()
      expect(rerunResult.exitCode).toBe(0)
      expect(rerunResult.stdout).toContain('Configure complete')

      const checkpoints = parseCheckpoints(rerunResult.stdout)
      expect(checkpoints.get('agent_key')).toBe('already_ok')
      expect(checkpoints.get('account')).toBe('already_ok')

      // ── Verify persisted config ───────────────────────────────────────────

      const config = await readAgentWalletConfig(env.configHome)
      expect(config.porto?.address?.toLowerCase()).toBe(account.address.toLowerCase())
      expect(config).toMatchInlineSnapshot({
        porto: { address: expect.any(String) },
        signer: { handle: expect.any(String) },
      }, `
        {
          "porto": {
            "address": Any<String>,
            "chainId": 84532,
            "dialogHost": "id.porto.sh",
            "precallPermissions": [],
            "testnet": true,
          },
          "signer": {
            "backend": "secure-enclave",
            "handle": Any<String>,
            "keyId": "se.agent.wallet.default",
          },
          "version": 1,
        }
      `)
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

// Human-readable text normalization: replace values after known dynamic labels.
function normalizeText(text: string): string {
  return text
    .replace(/relayUrl=\S+/g, 'relayUrl=[dynamic]')
    .replace(/^(Account: )\S+/m, '$1[dynamic]')
    .replace(/^(Permission ID: )\S+/m, '$1[dynamic]')
    .replace(/^(Latest permission expiry: )\S+/m, '$1[dynamic]')
    .replace(/^(\s+- )\S+( expires )\S+/m, '$1[dynamic]$2[dynamic]')
    .replace(/^(- )[\d.]+ (ETH|EXP|USDC)/gm, '$1[dynamic] $2')
}
