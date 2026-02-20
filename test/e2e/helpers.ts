import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { execa } from 'execa'
import { chromium, type CDPSession, type Locator, type Page } from 'playwright'
import { createPublicClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'

export type CliRunResult = {
  exitCode: number
  payload: Record<string, unknown> | null
  stderr: string
  stdout: string
}

type IsolatedEnv = {
  configHome: string
  env: NodeJS.ProcessEnv
}

export type LiveSession = {
  accountAddress: `0x${string}`
  allowlistTo: `0x${string}`
  chainId: number
  configHome: string
  env: NodeJS.ProcessEnv
  network: 'prod' | 'testnet'
}

type AgentWalletConfig = {
  porto?: {
    address?: `0x${string}`
    chainId?: number
    permissionIds?: `0x${string}`[]
  }
}

const DEFAULT_ALLOWLIST_TO = '0x000000000000000000000000000000000000dEaD'
const DEFAULT_RELAY_RPC_URL = 'https://rpc.porto.sh'
const BASE_SEPOLIA_EXP_TOKEN = '0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e'
const BASE_SEPOLIA_FAUCET_VALUE = '0x340aad21b3b700000'
const PROCESS_TIMEOUT_MS = 3 * 60 * 1_000
const DIALOG_URL_REGEX = /https?:\/\/\S+/g
const AUTH_ACTION_COOLDOWN_MS = 4_000
const DEBUG = process.env.AGENT_WALLET_E2E_DEBUG === '1'
const BROWSER_HEADLESS =
  process.env.AGENT_WALLET_E2E_HEADLESS === '0' ||
  process.env.AGENT_WALLET_E2E_HEADLESS === 'false'
    ? false
    : true
const STRICT_DIALOG_ERRORS =
  process.env.AGENT_WALLET_E2E_STRICT_DIALOG === '0' ||
  process.env.AGENT_WALLET_E2E_STRICT_DIALOG === 'false'
    ? false
    : true

let sharedLiveSession: Promise<LiveSession> | undefined

export async function makeIsolatedEnv(): Promise<IsolatedEnv> {
  const configHome = await mkdtemp(path.join(os.tmpdir(), 'agent-wallet-e2e-'))

  return {
    configHome,
    env: {
      ...process.env,
      AGENT_WALLET_CONFIG_HOME: configHome,
    },
  }
}

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<CliRunResult> {
  if (DEBUG) {
    console.error(`[e2e][runCli] node dist/agent-wallet.js ${args.join(' ')}`)
  }

  const result = await execa('node', ['dist/agent-wallet.js', ...args], {
    env,
    reject: false,
    timeout: timeoutMs,
  })

  const timeoutNote = result.timedOut ? `\n[e2e][runCli] timed out after ${String(timeoutMs)}ms` : ''
  const stderr = `${result.stderr}${timeoutNote}`

  if (DEBUG) {
    console.error(
      `[e2e][runCli] exit=${String(result.exitCode ?? 1)} timedOut=${String(result.timedOut)}\nstdout:\n${result.stdout}\n\nstderr:\n${stderr}`,
    )
  }

  const output = (result.stdout || stderr || '').trim()
  const payload = parseJsonPayload(output)

  return {
    exitCode: result.exitCode ?? 1,
    payload,
    stderr,
    stdout: result.stdout,
  }
}

export function getLiveNetwork(): 'prod' | 'testnet' {
  return process.env.AGENT_WALLET_E2E_NETWORK === 'prod' ? 'prod' : 'testnet'
}

export async function getLiveSession(): Promise<LiveSession> {
  if (!sharedLiveSession) {
    sharedLiveSession = createLiveSession().catch((error) => {
      sharedLiveSession = undefined
      throw error
    })
  }

  return sharedLiveSession
}

export async function runConfigureRerun(session: LiveSession): Promise<CliRunResult> {
  const args = buildConfigureArgs({
    allowlistTo: session.allowlistTo,
    dialogHost: process.env.AGENT_WALLET_E2E_DIALOG_HOST,
    mode: 'human',
    network: session.network,
  })

  return runConfigureWithVirtualPasskey({
    args,
    env: session.env,
  })
}

export async function readAgentWalletConfig(configHome: string): Promise<AgentWalletConfig> {
  const configPath = path.join(configHome, 'agent-wallet', 'config.json')
  const raw = await readFile(configPath, 'utf8')
  return JSON.parse(raw) as AgentWalletConfig
}

async function createLiveSession(): Promise<LiveSession> {
  const isolated = await makeIsolatedEnv()
  const network = getLiveNetwork()
  const allowlistTo = (process.env.AGENT_WALLET_E2E_ALLOWLIST_TO ?? DEFAULT_ALLOWLIST_TO) as `0x${string}`
  const dialogHost = process.env.AGENT_WALLET_E2E_DIALOG_HOST

  const configureArgs = buildConfigureArgs({
    allowlistTo,
    createAccount: true,
    dialogHost,
    mode: 'human',
    network,
  })

  const configureResult = await runConfigureWithVirtualPasskey({
    args: configureArgs,
    env: isolated.env,
  })

  if (configureResult.exitCode !== 0) {
    throw new Error(
      `Live configure failed (exit ${String(configureResult.exitCode)}).\nstdout:\n${configureResult.stdout}\n\nstderr:\n${configureResult.stderr}`,
    )
  }

  const statusResult = await runCli(['status', '--json'], isolated.env)
  if (statusResult.exitCode !== 0 || !statusResult.payload || statusResult.payload.ok !== true) {
    throw new Error(
      `Status check failed after configure.\nstdout:\n${statusResult.stdout}\n\nstderr:\n${statusResult.stderr}`,
    )
  }

  const account = statusResult.payload.account as
    | {
        address?: string | null
        chainId?: number | null
      }
    | undefined

  if (!account?.address || typeof account.chainId !== 'number') {
    throw new Error(`Status payload missing account details: ${JSON.stringify(statusResult.payload)}`)
  }

  const config = await readAgentWalletConfig(isolated.configHome)

  await ensureSessionFunding({
    accountAddress: account.address as `0x${string}`,
    chainId: account.chainId,
    network,
  })

  return {
    accountAddress: account.address as `0x${string}`,
    allowlistTo,
    chainId: account.chainId,
    configHome: isolated.configHome,
    env: isolated.env,
    network,
  }
}

async function ensureSessionFunding(parameters: {
  accountAddress: `0x${string}`
  chainId: number
  network: 'prod' | 'testnet'
}) {
  const { accountAddress, chainId, network } = parameters
  if (network !== 'testnet') return
  if (chainId !== baseSepolia.id) return

  const rpcUrl = process.env.AGENT_WALLET_RELAY_URL ?? DEFAULT_RELAY_RPC_URL
  const payload = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: Date.now(),
      jsonrpc: '2.0',
      method: 'wallet_addFaucetFunds',
      params: [
        {
          address: accountAddress,
          chainId,
          tokenAddress: BASE_SEPOLIA_EXP_TOKEN,
          value: BASE_SEPOLIA_FAUCET_VALUE,
        },
      ],
    }),
  }).then((response) => response.json() as Promise<{ result?: { transactionHash?: `0x${string}` }; error?: { message?: string } }>)

  if (payload.error) {
    throw new Error(`Failed to faucet-fund e2e account: ${payload.error.message ?? 'unknown relay error'}`)
  }

  const faucetTxHash = payload.result?.transactionHash
  if (!faucetTxHash) {
    throw new Error('Relay faucet response did not include a transaction hash.')
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(baseSepolia.rpcUrls.default.http[0]),
  })

  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
    const receipt = await publicClient.getTransactionReceipt({ hash: faucetTxHash }).catch(() => null)
    if (receipt?.blockNumber) {
      const latest = await publicClient.getBlockNumber()
      if (latest - receipt.blockNumber + 1n >= 1n) return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error(`Timed out waiting for faucet transaction confirmation: ${faucetTxHash}`)
}

async function runConfigureWithVirtualPasskey(parameters: {
  args: string[]
  env: NodeJS.ProcessEnv
}): Promise<CliRunResult> {
  const { args, env } = parameters

  const child = spawn('node', ['dist/agent-wallet.js', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let stdoutBuffer = ''

  let page: Page | undefined
  let webAuthnSession: CDPSession | undefined

  let dialogQueue = Promise.resolve()
  let dialogError: Error | undefined
  let successfulDialogActions = 0
  let cliExited = false

  const ensurePage = async () => {
    if (page && webAuthnSession) return { page, webAuthnSession }

    const browser = await chromium.launch({
      args: [
        '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights',
        '--disable-web-security',
      ],
      headless: BROWSER_HEADLESS,
      slowMo: BROWSER_HEADLESS ? 0 : 150,
    })

    const context = await browser.newContext()
    page = await context.newPage()
    if (DEBUG) {
      page.on('console', (message) => {
        console.error(`[e2e][dialog][console][${message.type()}] ${message.text()}`)
      })
      page.on('pageerror', (error) => {
        console.error(`[e2e][dialog][pageerror] ${error.message}`)
      })
      page.on('requestfailed', (request) => {
        console.error(
          `[e2e][dialog][requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
        )
      })
    }

    webAuthnSession = await context.newCDPSession(page)
    await webAuthnSession.send('WebAuthn.enable')
    await webAuthnSession.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        automaticPresenceSimulation: true,
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        protocol: 'ctap2',
        transport: 'internal',
      },
    })

    return { page, webAuthnSession }
  }

  const onStdoutLine = (line: string) => {
    stdout += `${line}\n`
    if (DEBUG) {
      console.error(`[e2e][configure][stdout] ${line}`)
    }

    const urls = extractDialogUrls(line)
    for (const url of urls) {
      if (cliExited) {
        continue
      }

      dialogQueue = dialogQueue
        .then(async () => {
          if (cliExited) {
            return
          }

          if (DEBUG) {
            console.error(`[e2e][configure][dialog] opening ${url}`)
          }
          const { page } = await ensurePage()
          await page.goto(url, { timeout: 60_000, waitUntil: 'domcontentloaded' })
          const preferSignIn =
            successfulDialogActions > 0 || !args.includes('--create-account')
          const actions = await settleDialog(page, {
            preferSignIn,
            shouldStop: () => cliExited,
          })
          successfulDialogActions += actions
          if (actions === 0) {
            if (!STRICT_DIALOG_ERRORS && successfulDialogActions > 0) {
              if (DEBUG) {
                console.error('[e2e][configure][dialog] no actionable controls on a follow-up URL; skipping')
              }
              return
            }
            const title = await page.title()
            const bodyText = (await page.locator('body').innerText()).slice(0, 500)
            const frameCount = page.frames().length
            const frameUrlList = page.frames().map((frame) => frame.url()).join(', ')
            if (DEBUG) {
              const screenshotPath = path.join(os.tmpdir(), `agent-wallet-e2e-dialog-${Date.now()}.png`)
              await page.screenshot({ path: screenshotPath, fullPage: true })
              console.error(`[e2e][configure][dialog] screenshot ${screenshotPath}`)
            }
            throw new Error(
              `Dialog loaded but no actionable controls were detected. title=\"${title}\" body=\"${bodyText}\" frameCount=${String(frameCount)} frames=\"${frameUrlList}\"`,
            )
          }
          if (DEBUG) {
            console.error(`[e2e][configure][dialog] settled ${url}`)
          }
        })
        .catch((error: unknown) => {
          dialogError = toError(error)
          child.kill('SIGTERM')
        })
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk

    while (stdoutBuffer.includes('\n')) {
      const newlineIndex = stdoutBuffer.indexOf('\n')
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      onStdoutLine(line)
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    if (DEBUG) {
      console.error(`[e2e][configure][stderr] ${chunk}`)
    }
  })

  child.once('exit', () => {
    cliExited = true
  })

  const exitCode = await waitForProcessExit(child, PROCESS_TIMEOUT_MS)

  if (stdoutBuffer.length > 0) {
    onStdoutLine(stdoutBuffer)
  }

  await dialogQueue

  if (page) {
    await page.context().close()
  }

  if (dialogError) {
    throw dialogError
  }

  const output = (stdout || stderr).trim()
  const payload = parseJsonPayload(output)

  return {
    exitCode,
    payload,
    stderr,
    stdout,
  }
}

async function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`CLI timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code ?? 1)
    })
  })
}

function buildConfigureArgs(parameters: {
  allowlistTo: `0x${string}`
  createAccount?: boolean
  dialogHost?: string
  mode: 'human' | 'json'
  network: 'prod' | 'testnet'
}): string[] {
  const { allowlistTo, createAccount, dialogHost, mode, network } = parameters

  const args = ['configure', '--headless', `--${mode}`, '--calls', JSON.stringify([{ to: allowlistTo }])]

  if (createAccount) {
    args.push('--create-account')
  }

  if (network === 'testnet') {
    args.push('--testnet')
  }

  if (dialogHost) {
    args.push('--dialog', dialogHost)
  }

  return args
}

function extractDialogUrls(line: string): string[] {
  const matches = line.match(DIALOG_URL_REGEX) ?? []
  return matches.filter((candidate) => candidate.includes('/dialog') && candidate.includes('relayUrl='))
}

async function settleDialog(
  page: Page,
  options: {
    preferSignIn: boolean
    shouldStop: () => boolean
  },
): Promise<number> {
  const startedAt = Date.now()
  const timeoutMs = 90_000
  let lastActionAt = Date.now()
  let actionCount = 0
  const attemptedActions = new Set<string>()
  let mostRecentAction:
    | 'buy'
    | 'faucet'
    | 'confirm'
    | 'grant'
    | 'sign-in'
    | 'sign-up'
    | undefined
  let mostRecentActionAt = 0

  while (Date.now() - startedAt < timeoutMs) {
    if (options.shouldStop()) {
      return actionCount
    }

    const action = await runDialogActions(page, {
      attemptedActions,
      mostRecentAction,
      mostRecentActionAt,
      preferSignIn: options.preferSignIn,
    })

    if (action) {
      attemptedActions.add(action)
      const now = Date.now()
      lastActionAt = now
      mostRecentAction = action
      mostRecentActionAt = now
      actionCount += 1
      await page.waitForTimeout(400)
      continue
    }

    // After initial auth, later requests (funding/grant) can arrive on the same
    // already-open dialog URL with noticeable delay.
    const idleThresholdMs =
      actionCount > 0
        ? attemptedActions.has('grant')
          ? 8_000
          : 60_000
        : 12_000
    if (Date.now() - lastActionAt > idleThresholdMs) {
      return actionCount
    }

    await page.waitForTimeout(300)
  }

  throw new Error('Timed out waiting for dialog actions to settle.')
}

async function runDialogActions(
  page: Page,
  options: {
    attemptedActions: Set<string>
    mostRecentAction?: 'buy' | 'faucet' | 'confirm' | 'grant' | 'sign-in' | 'sign-up'
    mostRecentActionAt: number
    preferSignIn: boolean
  },
): Promise<'buy' | 'faucet' | 'confirm' | 'grant' | 'sign-in' | 'sign-up' | null> {
  const iframe = page.frameLocator('[data-testid=\"porto\"]')
  const now = Date.now()

  const preferSignInNow = options.preferSignIn || options.attemptedActions.has('sign-up')
  const authSequence = preferSignInNow
    ? [
        {
          label: 'sign-in' as const,
          locators: [
            iframe.getByTestId('sign-in'),
            iframe.getByRole('button', { name: /sign in|continue/i }),
            page.getByTestId('sign-in'),
            page.getByRole('button', { name: /sign in|continue/i }),
          ],
        },
      ]
    : [
        {
          label: 'sign-up' as const,
          locators: [
            iframe.getByTestId('sign-up'),
            iframe.getByRole('button', { name: /sign up|create account/i }),
            page.getByTestId('sign-up'),
            page.getByRole('button', { name: /sign up|create account/i }),
          ],
        },
        {
          label: 'sign-in' as const,
          locators: [
            iframe.getByTestId('sign-in'),
            iframe.getByRole('button', { name: /sign in|continue/i }),
            page.getByTestId('sign-in'),
            page.getByRole('button', { name: /sign in|continue/i }),
          ],
        },
      ]

  for (const step of authSequence) {
    if (
      options.mostRecentAction === step.label &&
      now - options.mostRecentActionAt < AUTH_ACTION_COOLDOWN_MS
    ) {
      continue
    }

    const clicked = await clickAny(step.locators)
    if (!clicked) continue
    if (DEBUG) {
      console.error(`[e2e][configure][dialog] clicked ${step.label}`)
    }
    return step.label
  }

  const clickedFaucet = await clickAny([
    ...(options.attemptedActions.has('faucet')
      ? []
      : [
          iframe.getByTestId('add-faucet-funds'),
          iframe.getByRole('button', { name: /add faucet funds/i }),
          page.getByTestId('add-faucet-funds'),
          page.getByRole('button', { name: /add faucet funds/i }),
        ]),
  ])
  if (clickedFaucet) {
    if (DEBUG) console.error('[e2e][configure][dialog] clicked faucet')
    return 'faucet'
  }

  const clickedBuy = await clickAny([
    ...(options.attemptedActions.has('buy')
      ? []
      : [
          iframe.getByTestId('buy'),
          iframe.getByRole('button', { name: /buy|add funds/i }),
          page.getByTestId('buy'),
          page.getByRole('button', { name: /buy|add funds/i }),
        ]),
  ])
  if (clickedBuy) {
    if (DEBUG) console.error('[e2e][configure][dialog] clicked buy')
    return 'buy'
  }

  const clickedGrant = await clickAny([
    ...(options.attemptedActions.has('grant')
      ? []
      : [
          iframe.getByTestId('grant'),
          iframe.getByRole('button', { name: /grant|approve/i }),
          page.getByTestId('grant'),
          page.getByRole('button', { name: /grant|approve/i }),
        ]),
  ])
  if (clickedGrant) {
    if (DEBUG) console.error('[e2e][configure][dialog] clicked grant')
    return 'grant'
  }

  const clickedConfirm = await clickAny([
    ...(options.attemptedActions.has('confirm')
      ? []
      : [
          iframe.getByTestId('confirm'),
          iframe.getByRole('button', { name: /confirm|approve|continue/i }),
          page.getByTestId('confirm'),
          page.getByRole('button', { name: /confirm|approve|continue/i }),
        ]),
  ])
  if (clickedConfirm) {
    if (DEBUG) console.error('[e2e][configure][dialog] clicked confirm')
    return 'confirm'
  }

  return null
}

async function clickAny(locators: Locator[]): Promise<boolean> {
  for (const locator of locators) {
    if ((await locator.count()) === 0) continue

    const target = locator.first()
    const visible = await target.isVisible().catch(() => false)
    if (!visible) continue
    const enabled = await target.isEnabled().catch(() => false)
    if (!enabled) continue

    try {
      await target.click({ timeout: 1_500 })
      return true
    } catch {
      continue
    }
  }

  return false
}

function parseJsonPayload(output: string): Record<string, unknown> | null {
  if (!output) return null

  try {
    return JSON.parse(output) as Record<string, unknown>
  } catch {
    return null
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}
