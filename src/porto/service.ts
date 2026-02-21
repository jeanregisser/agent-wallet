import { Chains, Mode, Porto } from 'porto'
import * as WalletActions from 'porto/viem/WalletActions'
import { createPublicClient, formatEther, http, type Chain } from 'viem'
import { getCallsStatus } from 'viem/actions'
import * as WalletClient from 'porto/viem/WalletClient'

import { AppError } from '../lib/errors.js'
import { parseJsonFlag } from '../lib/encoding.js'
import type { AgentWalletConfig } from '../lib/config.js'
import type { SignerService } from '../signer/service.js'

type GrantCallPermission = {
  to?: `0x${string}`
  signature?: string
}

type SendCall = {
  data?: `0x${string}`
  to: `0x${string}`
  value?: bigint | `0x${string}` | number | string
}

type OnboardOptions = {
  dialogHost?: string
  headless?: boolean
  nonInteractive?: boolean
  testnet?: boolean
  createAccount?: boolean
  grantOptions?: {
    calls: string
    defaults?: boolean
    expiry?: string
    spendLimit?: number
  }
}

type GrantOptions = {
  address?: `0x${string}`
  chainId?: number
  expiry?: string
  spendLimit?: number
  calls?: string
  defaults?: boolean
}

type SendOptions = {
  address?: `0x${string}`
  chainId?: number
  calls: string
}

type FundOptions = {
  address?: `0x${string}`
  chainId?: number
}

type PermissionsOptions = {
  address?: `0x${string}`
  chainId?: number
}

const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEFAULT_RELAY_RPC_URL = 'https://rpc.porto.sh'
const ZERO_TX_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'
const BASE_SEPOLIA_EXP_TOKEN = '0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e'
const BASE_SEPOLIA_FAUCET_VALUE = '0x340aad21b3b700000'
const RELAY_REQUEST_TIMEOUT_MS = 20_000
const SEND_STAGE_TIMEOUT_MS = 90_000
const SEND_STATUS_REQUEST_TIMEOUT_MS = 12_000
const SEND_STATUS_POLL_TIMEOUT_MS = 45_000
const SEND_STATUS_POLL_INTERVAL_MS = 1_500

type RelayPermissionCall = {
  selector: `0x${string}`
  to: `0x${string}`
  type: 'call'
}

type RelayPermissionSpend = {
  limit: bigint
  period: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
  token?: `0x${string}` | null
  type: 'spend'
}

type RelayKeyRecord = {
  expiry: number
  hash?: `0x${string}`
  permissions: readonly (RelayPermissionCall | RelayPermissionSpend)[]
  publicKey: `0x${string}`
  role: 'admin' | 'normal'
  type: 'p256' | 'secp256k1' | 'webauthnp256'
}

type AgentPermissionSnapshot = {
  expiry: number
  id: `0x${string}`
  key: {
    publicKey: `0x${string}`
    type: 'p256' | 'secp256k1' | 'webauthn-p256'
  }
  permissions: {
    calls: { signature?: string; to?: `0x${string}` }[]
    spend: {
      limit: bigint
      period: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
      token?: `0x${string}` | null
    }[]
  }
}

function getChain(testnet?: boolean) {
  return testnet ? Chains.baseSepolia : Chains.base
}

function getChainById(chainId?: number) {
  if (!chainId) return undefined
  if (chainId === Chains.base.id) return Chains.base
  if (chainId === Chains.baseSepolia.id) return Chains.baseSepolia
  return undefined
}

function resolveConfiguredChain(config: AgentWalletConfig, overrideChainId?: number): Chain | undefined {
  const configured = getChainById(overrideChainId ?? config.porto?.chainId)
  if (configured) return configured

  if (config.porto?.testnet === true) return Chains.baseSepolia
  if (config.porto?.testnet === false) return Chains.base

  return undefined
}

function normalizeDialogHost(host?: string) {
  return host ?? 'id.porto.sh'
}

function normalizeRelayRpcUrl() {
  return process.env.AGENT_WALLET_RELAY_URL ?? DEFAULT_RELAY_RPC_URL
}

function normalizeRelayKeyType(type: RelayKeyRecord['type']) {
  if (type === 'webauthnp256') return 'webauthn-p256' as const
  return type
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMetadata(error: unknown) {
  if (!isObject(error)) {
    return {
      message: String(error),
    }
  }

  const candidate = error as Record<string, unknown>
  const message =
    typeof candidate.message === 'string'
      ? candidate.message
      : String(error)

  return {
    code:
      typeof candidate.code === 'string' || typeof candidate.code === 'number'
        ? candidate.code
        : undefined,
    details: typeof candidate.details === 'string' ? candidate.details : undefined,
    message,
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    shortMessage: typeof candidate.shortMessage === 'string' ? candidate.shortMessage : undefined,
  }
}

function isRelayKeyRecord(value: unknown): value is RelayKeyRecord {
  if (!isObject(value)) return false
  if (typeof value.expiry !== 'number') return false
  if (typeof value.hash !== 'undefined') {
    if (typeof value.hash !== 'string' || !value.hash.startsWith('0x')) return false
  }
  if (typeof value.publicKey !== 'string' || !value.publicKey.startsWith('0x')) return false
  if (value.role !== 'admin' && value.role !== 'normal') return false
  if (value.type !== 'p256' && value.type !== 'secp256k1' && value.type !== 'webauthnp256') return false
  if (!Array.isArray(value.permissions)) return false
  return true
}

let relayRequestId = 0

async function requestRelay<T>(method: string, params: unknown[]): Promise<T> {
  let response: Response
  try {
    response = await fetch(normalizeRelayRpcUrl(), {
      body: JSON.stringify({
        id: ++relayRequestId,
        jsonrpc: '2.0',
        method,
        params,
      }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(RELAY_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const metadata = errorMetadata(error)
    const message = metadata.message.toLowerCase()
    const timedOut = message.includes('timed out') || message.includes('timeout') || message.includes('aborted')
    throw new AppError(
      timedOut ? 'RELAY_REQUEST_TIMEOUT' : 'RELAY_HTTP_ERROR',
      timedOut ? 'Relay request timed out.' : 'Relay request failed.',
      {
        ...metadata,
        method,
        timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
      },
    )
  }

  if (!response.ok) {
    throw new AppError('RELAY_HTTP_ERROR', 'Relay request failed.', {
      method,
      status: response.status,
      statusText: response.statusText,
    })
  }

  const payload = (await response.json()) as {
    error?: {
      code?: number
      data?: unknown
      message?: string
    }
    result?: T
  }

  if (payload.error) {
    throw new AppError('RELAY_RPC_ERROR', payload.error.message ?? 'Relay returned an error.', {
      code: payload.error.code,
      data: payload.error.data,
      method,
    })
  }

  if (typeof payload.result === 'undefined') {
    throw new AppError('RELAY_INVALID_RESPONSE', 'Relay response is missing result.', { method })
  }

  return payload.result
}

async function withTimeout<T>(
  operation: Promise<T>,
  options: {
    code: string
    message: string
    details?: Record<string, unknown>
    timeoutMs?: number
  },
) {
  const timeoutMs = options.timeoutMs ?? SEND_STAGE_TIMEOUT_MS
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new AppError(options.code, options.message, {
              ...options.details,
              timeoutMs,
            }),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

type CallsStatusSnapshot = Awaited<ReturnType<typeof getCallsStatus>>

function extractTransactionHash(snapshot: CallsStatusSnapshot) {
  const hash = snapshot.receipts?.[0]?.transactionHash
  return hash ? String(hash) : null
}

async function waitForBundleSettlement(
  client: ReturnType<typeof WalletClient.fromPorto>,
  bundleId: `0x${string}`,
) {
  const deadline = Date.now() + SEND_STATUS_POLL_TIMEOUT_MS
  let status = 'pending'
  let txHash: string | null = null

  while (Date.now() <= deadline) {
    try {
      const snapshot = await withTimeout(
        getCallsStatus(client, {
          id: bundleId,
        }),
        {
          code: 'PORTO_SEND_STATUS_TIMEOUT',
          details: {
            bundleId,
            stage: 'send_prepared',
          },
          message: 'Timed out while fetching call status.',
          timeoutMs: SEND_STATUS_REQUEST_TIMEOUT_MS,
        },
      )

      status = snapshot.status ?? status
      txHash = extractTransactionHash(snapshot)
      if (txHash) break

      if (status !== 'pending') break
    } catch {
      // Best effort polling only: continue until deadline.
    }

    if (Date.now() + SEND_STATUS_POLL_INTERVAL_MS > deadline) {
      break
    }
    await sleep(SEND_STATUS_POLL_INTERVAL_MS)
  }

  return {
    status,
    txHash,
  }
}

type WalletSession = {
  client: ReturnType<typeof WalletClient.fromPorto>
  destroy: () => void
}

let sharedWalletSession: WalletSession | undefined
let hasRegisteredSessionCleanup = false

async function getWalletClient(options: {
  address?: `0x${string}`
  dialogHost?: string
  mode?: 'dialog' | 'relay'
  testnet?: boolean
}) {
  if (sharedWalletSession) {
    return {
      client: sharedWalletSession.client,
      close: () => {},
    }
  }

  const chain = getChain(options.testnet)
  const transportMode = options.mode ?? 'dialog'
  let porto: ReturnType<typeof Porto.create>

  if (transportMode === 'relay') {
    porto = Porto.create({
      announceProvider: false,
      chains: [Chains.base, Chains.baseSepolia],
      mode: Mode.relay(),
      relay: http(normalizeRelayRpcUrl()),
    })
  } else {
    const { cli: createCliDialog } = await import('porto/cli/Dialog')
    const host = normalizeDialogHost(options.dialogHost)
    porto = Porto.create({
      announceProvider: false,
      chains: [Chains.base, Chains.baseSepolia],
      mode: Mode.dialog({
        host: new URL('/dialog', `https://${host}`).toString(),
        renderer: await createCliDialog(),
      }),
    })
  }

  sharedWalletSession = {
    client: WalletClient.fromPorto(porto, {
      ...(options.address ? { account: options.address } : {}),
      chain,
    }),
    destroy: () => porto.destroy(),
  }

  if (!hasRegisteredSessionCleanup) {
    hasRegisteredSessionCleanup = true
    process.once('exit', () => {
      closeWalletSession()
    })
  }

  return {
    client: sharedWalletSession.client,
    close: () => {},
  }
}

export function closeWalletSession() {
  sharedWalletSession?.destroy()
  sharedWalletSession = undefined
}

function getUnixExpirySeconds(expiry?: string, defaults = false) {
  if (expiry) {
    const timestamp = Date.parse(expiry)
    if (Number.isNaN(timestamp)) {
      throw new AppError('INVALID_EXPIRY', 'Expiry must be a valid ISO-8601 timestamp.', {
        expiry,
      })
    }
    return Math.floor(timestamp / 1000)
  }

  if (defaults) {
    const secondsInDay = 24 * 60 * 60
    return Math.floor(Date.now() / 1000) + 7 * secondsInDay
  }

  throw new AppError('MISSING_EXPIRY', 'Missing required flag --expiry <iso8601>.')
}

function parseGrantCalls(calls?: string, defaults = false) {
  if (!calls) {
    const code = defaults ? 'MISSING_CALL_ALLOWLIST' : 'MISSING_CALLS'
    throw new AppError(code, 'Grant permissions requires --calls with at least one allowlisted target.')
  }

  const parsed = parseJsonFlag<GrantCallPermission[]>(calls, 'INVALID_CALLS_JSON')
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError('INVALID_CALLS_JSON', 'Grant calls must be a non-empty JSON array.')
  }

  return parsed.map((entry) => {
    if (!entry.to && !entry.signature) {
      throw new AppError(
        'INVALID_CALLS_JSON',
        'Each grant permission entry must include at least one of `to` or `signature`.',
      )
    }

    return entry
  }) as readonly ({ to: `0x${string}`; signature?: string } | { signature: string; to?: `0x${string}` })[]
}

function parseSendCalls(calls: string) {
  const parsed = parseJsonFlag<SendCall[]>(calls, 'INVALID_CALLS_JSON')

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError('INVALID_CALLS_JSON', 'Send calls must be a non-empty JSON array.')
  }

  return parsed.map((call) => {
    if (!call.to) {
      throw new AppError('INVALID_CALLS_JSON', 'Each send call must include a `to` address.')
    }

    let value: bigint | undefined
    if (call.value !== undefined) {
      try {
        value = typeof call.value === 'bigint' ? call.value : BigInt(call.value)
      } catch {
        throw new AppError(
          'INVALID_CALLS_JSON',
          'Each send call `value` must be a non-negative integer (decimal or 0x hex).',
        )
      }

      if (value < 0n) {
        throw new AppError(
          'INVALID_CALLS_JSON',
          'Each send call `value` must be a non-negative integer (decimal or 0x hex).',
        )
      }
    }

    return {
      ...call,
      ...(value !== undefined ? { value } : {}),
    }
  })
}

export class PortoService {
  constructor(
    private readonly config: AgentWalletConfig,
    private readonly signer: SignerService,
  ) {}

  private async buildGrantPermissionsParam(
    chain: ReturnType<typeof getChain>,
    grantOptions: NonNullable<OnboardOptions['grantOptions']>,
  ) {
    const key = await this.signer.getPortoKey()
    const defaults = Boolean(grantOptions.defaults)
    const callPermissions = parseGrantCalls(grantOptions.calls, defaults)
    const perTxUsd = grantOptions.spendLimit ?? 25
    const dailyUsd = 100
    const feeTokenSymbol = chain.id === Chains.baseSepolia.id ? 'EXP' : 'native'
    return {
      expiry: getUnixExpirySeconds(grantOptions.expiry, defaults),
      feeToken: defaults
        ? ({ limit: String(perTxUsd) as `${number}`, symbol: feeTokenSymbol })
        : null,
      key,
      permissions: {
        calls: callPermissions,
        ...(defaults
          ? { spend: [{ limit: BigInt(Math.round(dailyUsd * 1_000_000)), period: 'day' as const }] }
          : {}),
      },
    }
  }

  private async listAgentPermissions(options: {
    address?: `0x${string}`
    chainId?: number
    includeExpired?: boolean
  }): Promise<AgentPermissionSnapshot[]> {
    const address = options.address ?? this.config.porto?.address
    if (!address) {
      throw new AppError('MISSING_ACCOUNT_ADDRESS', 'No account address configured. Run `agent-wallet configure` first.')
    }

    const chain = resolveConfiguredChain(this.config, options.chainId)
    if (!chain) {
      throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
    }

    const agentKey = await this.signer.getPortoKey()
    const relayKeys = await requestRelay<Record<string, unknown>>('wallet_getKeys', [
      {
        address,
        chainIds: [chain.id],
      },
    ])

    const nowSeconds = Math.floor(Date.now() / 1_000)
    const flattened = Object.values(relayKeys)
      .flatMap((value) => (Array.isArray(value) ? value : []))
      .filter(isRelayKeyRecord)

    return flattened
      .filter((candidate) => candidate.role === 'normal')
      .filter((candidate) => normalizeRelayKeyType(candidate.type) === agentKey.type)
      .filter((candidate) => candidate.publicKey.toLowerCase() === agentKey.publicKey.toLowerCase())
      .filter((candidate) => (options.includeExpired ? true : candidate.expiry > nowSeconds))
      .map((candidate) => {
        const calls = candidate.permissions
          .filter((permission): permission is RelayPermissionCall => permission.type === 'call')
          .map((permission) => ({
            signature: permission.selector,
            to: permission.to,
          }))
        const spend = candidate.permissions
          .filter((permission): permission is RelayPermissionSpend => permission.type === 'spend')
          .map((permission) => ({
            limit: permission.limit,
            period: permission.period,
            token: permission.token,
          }))

        return {
          expiry: candidate.expiry,
          id: (candidate.hash ?? candidate.publicKey) as `0x${string}`,
          key: {
            publicKey: candidate.publicKey,
            type: normalizeRelayKeyType(candidate.type),
          },
          permissions: {
            calls,
            spend,
          },
        }
      })
      .sort((left, right) => right.expiry - left.expiry)
  }

  async activePermission(options: { address?: `0x${string}`; chainId?: number }) {
    const permissions = await this.listAgentPermissions({
      address: options.address,
      chainId: options.chainId,
    })

    const [active] = permissions
    if (!active) return null

    return {
      expiry: active.expiry,
      permissionId: active.id,
    }
  }

  async permissionSummary(options: { address?: `0x${string}`; chainId?: number }) {
    const permissions = await this.listAgentPermissions({
      address: options.address,
      chainId: options.chainId,
      includeExpired: true,
    })

    const nowSeconds = Math.floor(Date.now() / 1_000)
    const active = permissions.filter((permission) => permission.expiry > nowSeconds)

    return {
      active: active.length,
      latestExpiry: active[0] ? new Date(active[0].expiry * 1_000).toISOString() : null,
      total: permissions.length,
    }
  }

  async onboard(options: OnboardOptions) {
    if (options.nonInteractive && !options.headless) {
      throw new AppError(
        'NON_INTERACTIVE_REQUIRES_FLAGS',
        'Command requires an interactive TTY. Re-run with explicit flags or --headless.',
        {
          command: 'agent-wallet porto onboard',
          hint: 'Use --headless in CI/agent environments.',
        },
      )
    }

    const chain = getChain(options.testnet)
    let session: Awaited<ReturnType<typeof getWalletClient>> | undefined
    try {
      try {
        session = await getWalletClient({
          dialogHost: options.dialogHost,
          testnet: options.testnet,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('listen EPERM')) {
          throw new AppError(
            'PORTO_LOCAL_RELAY_BIND_FAILED',
            'Unable to start local Porto CLI relay listener. Ensure local loopback bind is allowed.',
            {
              hint: 'In restricted sandbox/CI environments, allow local port binding or run onboarding outside sandbox.',
            },
          )
        }
        throw error
      }

      const grantPermissionsParam = options.grantOptions
        ? await this.buildGrantPermissionsParam(chain, options.grantOptions)
        : undefined

      const response = await WalletActions.connect(session.client, {
        chainIds: [chain.id],
        ...(options.createAccount
          ? { createAccount: true }
          : { selectAccount: true }),
        ...(grantPermissionsParam ? { grantPermissions: grantPermissionsParam } : {}),
      })

      const account = response.accounts[0]
      if (!account?.address) {
        throw new AppError('ONBOARD_FAILED', 'Porto onboarding did not return an account address.')
      }

      const grantedPermission = grantPermissionsParam
        ? (response.accounts[0]?.capabilities?.permissions?.find(
            (p) => p.key.publicKey.toLowerCase() === grantPermissionsParam.key.publicKey.toLowerCase(),
          ) ?? null)
        : null

      // Align with Porto CLI UX: notify dialog of success so the web page
      // can render a completion state instead of staying idle/blank.
      try {
        const { messenger } = await import('porto/cli/Dialog')
        const isCreate = Boolean(options.createAccount)
        messenger.send('success', {
          title: isCreate ? 'Account created' : 'Account connected',
          content: isCreate
            ? 'You have successfully created an account.'
            : 'You have successfully signed in to your account.',
        })

        // Give the message channel a brief moment to flush before process exit.
        await new Promise((resolve) => setTimeout(resolve, 300))
      } catch {
        // Non-fatal for onboard result; CLI output remains source of truth.
      }

      const addressChanged =
        this.config.porto?.address &&
        this.config.porto.address.toLowerCase() !== account.address.toLowerCase()

      const existingPermissionIds = addressChanged ? [] : (this.config.porto?.permissionIds ?? [])
      const permissionIds = grantedPermission
        ? (Array.from(new Set([...existingPermissionIds, grantedPermission.id])) as `0x${string}`[])
        : existingPermissionIds

      const defaults = options.grantOptions?.defaults
      this.config.porto = {
        ...this.config.porto,
        address: account.address,
        chainId: chain.id,
        dialogHost: normalizeDialogHost(options.dialogHost),
        testnet: Boolean(options.testnet),
        permissionIds,
        ...(grantedPermission && defaults
          ? {
              defaults: {
                perTxUsd: options.grantOptions?.spendLimit ?? 25,
                dailyUsd: 100,
                expiryDays: 7,
                allowlistRequired: true,
              },
            }
          : {}),
      }

      return {
        address: account.address,
        chainId: chain.id,
        grantedPermission: grantedPermission
          ? { id: grantedPermission.id, expiry: grantedPermission.expiry }
          : null,
      }
    } finally {
      session?.close()
    }
  }

  async grant(options: GrantOptions) {
    const session = await getWalletClient({
      address: options.address ?? this.config.porto?.address,
      dialogHost: this.config.porto?.dialogHost,
      testnet: this.config.porto?.testnet,
    })

    try {
      const key = await this.signer.getPortoKey()
      const defaults = Boolean(options.defaults)
      const callPermissions = parseGrantCalls(options.calls, defaults)
      const address = options.address ?? this.config.porto?.address
      const chain = resolveConfiguredChain(this.config, options.chainId)

      const perTxUsd = options.spendLimit ?? 25
      const dailyUsd = 100
      const feeTokenSymbol = chain?.id === Chains.baseSepolia.id ? 'EXP' : 'native'

      // Combine sign-in and permission grant into a single wallet_connect call
      // so the user only needs one dialog interaction instead of two.
      const connectResponse = await WalletActions.connect(session.client, {
        ...(chain ? { chainIds: [chain.id] } : {}),
        ...(address ? { selectAccount: { address } } : { selectAccount: true }),
        grantPermissions: {
          expiry: getUnixExpirySeconds(options.expiry, defaults),
          feeToken: defaults
            ? ({ limit: String(perTxUsd) as `${number}`, symbol: feeTokenSymbol })
            : null,
          key,
          permissions: {
            calls: callPermissions,
            ...(defaults
              ? { spend: [{ limit: BigInt(Math.round(dailyUsd * 1_000_000)), period: 'day' as const }] }
              : {}),
          },
        },
      })

      const grantedPermission = connectResponse.accounts[0]?.capabilities?.permissions?.find(
        (p) => p.key.publicKey.toLowerCase() === key.publicKey.toLowerCase(),
      )

      if (!grantedPermission) {
        throw new AppError('GRANT_FAILED', 'Porto did not return a granted permission.')
      }

      this.config.porto = {
        ...this.config.porto,
        permissionIds: Array.from(
          new Set([...(this.config.porto?.permissionIds ?? []), grantedPermission.id]),
        ) as `0x${string}`[],
        defaults: defaults
          ? { perTxUsd, dailyUsd, expiryDays: 7, allowlistRequired: true }
          : this.config.porto?.defaults,
      }

      return {
        permissionId: grantedPermission.id,
        expiry: grantedPermission.expiry,
        key: grantedPermission.key,
      }
    } finally {
      session.close()
    }
  }

  async fund(options: FundOptions) {
    const session = await getWalletClient({
      address: options.address ?? this.config.porto?.address,
      dialogHost: this.config.porto?.dialogHost,
      testnet: this.config.porto?.testnet,
    })

    try {
      const address = options.address ?? this.config.porto?.address
      if (!address) {
        throw new AppError('MISSING_ACCOUNT_ADDRESS', 'No account address configured. Run `agent-wallet configure` first.')
      }

      const chain = resolveConfiguredChain(this.config, options.chainId)
      if (!chain) {
        throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
      }

      await WalletActions.connect(session.client, {
        chainIds: [chain.id],
        selectAccount: {
          address,
        },
      })

      const response = await WalletActions.addFunds(session.client, {
        address,
        chainId: chain.id,
        ...(chain.id === Chains.base.id ? { token: NATIVE_TOKEN_ADDRESS } : {}),
      })

      if (chain.id === Chains.baseSepolia.id && response.id === ZERO_TX_HASH) {
        try {
          const fallback = await requestRelay<{ transactionHash: `0x${string}` }>('wallet_addFaucetFunds', [
            {
              address,
              chainId: chain.id,
              tokenAddress: BASE_SEPOLIA_EXP_TOKEN,
              value: BASE_SEPOLIA_FAUCET_VALUE,
            },
          ])

          return {
            id: fallback.transactionHash,
            kind: 'faucet',
          }
        } catch (error) {
          const metadata = errorMetadata(error)
          throw new AppError(
            'FUNDING_UNCONFIRMED',
            'Funding dialog returned a placeholder transaction id and faucet fallback failed.',
            {
              ...metadata,
              hint: 'Re-run configure and complete the faucet/add-funds dialog flow again.',
            },
          )
        }
      }

      return {
        id: response.id,
        kind: chain.id === Chains.baseSepolia.id ? 'faucet' : 'onramp',
      }
    } finally {
      session.close()
    }
  }

  async send(options: SendOptions) {
    const session = await getWalletClient({
      address: options.address ?? this.config.porto?.address,
      dialogHost: this.config.porto?.dialogHost,
      mode: 'relay',
      testnet: this.config.porto?.testnet,
    })

    let stage: 'prepare_calls' | 'sign_digest' | 'send_prepared' = 'prepare_calls'

    try {
      const key = await this.signer.getPortoKey()
      const calls = parseSendCalls(options.calls)
      const resolvedAddress = options.address ?? this.config.porto?.address
      const resolvedChainId = options.chainId ?? this.config.porto?.chainId
      const pendingPermission = this.config.porto?.pendingPermission
      const pendingPermissionId =
        pendingPermission &&
        pendingPermission.chainId === resolvedChainId &&
        (!options.address ||
          !this.config.porto?.address ||
          options.address.toLowerCase() === this.config.porto.address.toLowerCase())
          ? pendingPermission.id
          : undefined

      let prepared: Awaited<ReturnType<typeof WalletActions.prepareCalls>>
      try {
        stage = 'prepare_calls'
        prepared = await withTimeout(
          WalletActions.prepareCalls(session.client, {
            calls: calls as any,
            chainId: resolvedChainId,
            from: resolvedAddress,
            key,
          }),
          {
            code: 'PORTO_SEND_PREPARE_TIMEOUT',
            details: {
              pendingPermissionId: pendingPermissionId ?? null,
              stage,
            },
            message: 'Timed out while preparing calls via Porto.',
          },
        )
      } catch (error) {
        if (error instanceof AppError) throw error
        const metadata = errorMetadata(error)
        throw new AppError('PORTO_SEND_PREPARE_FAILED', 'Porto failed to prepare calls.', {
          ...metadata,
          pendingPermissionId: pendingPermissionId ?? null,
          stage,
        })
      }

      let signatureResult: Awaited<ReturnType<SignerService['sign']>>
      try {
        stage = 'sign_digest'
        signatureResult = await this.signer.sign(prepared.digest, 'hex', 'none')
      } catch (error) {
        const metadata = errorMetadata(error)
        throw new AppError('PORTO_SEND_SIGN_FAILED', 'Local signer failed to sign prepared digest.', {
          ...metadata,
          stage,
        })
      }

      let response: Awaited<ReturnType<typeof WalletActions.sendPreparedCalls>>
      try {
        stage = 'send_prepared'
        response = await withTimeout(
          WalletActions.sendPreparedCalls(session.client, {
            ...prepared,
            signature: signatureResult.signature as `0x${string}`,
          }),
          {
            code: 'PORTO_SEND_SUBMIT_TIMEOUT',
            details: {
              stage,
            },
            message: 'Timed out while submitting prepared calls via Porto.',
          },
        )
      } catch (error) {
        if (error instanceof AppError) throw error
        const metadata = errorMetadata(error)
        throw new AppError('PORTO_SEND_SUBMIT_FAILED', 'Porto failed to submit prepared calls.', {
          ...metadata,
          stage,
        })
      }

      const bundleId = response[0]?.id
      if (!bundleId) {
        throw new AppError('SEND_FAILED', 'Porto did not return a call bundle id.')
      }

      const settlement = await waitForBundleSettlement(session.client, bundleId)

      return {
        txHash: settlement.txHash,
        bundleId,
        status: settlement.status,
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      const metadata = errorMetadata(error)
      throw new AppError('PORTO_SEND_FAILED', 'Failed to prepare/sign/submit calls via Porto.', {
        ...metadata,
        stage,
      })
    } finally {
      session.close()
    }
  }

  async permissions(options: PermissionsOptions) {
    const permissions = await this.listAgentPermissions({
      address: options.address,
      chainId: options.chainId,
      includeExpired: true,
    })

    return {
      permissions,
    }
  }

  getChainDetails(chainId?: number) {
    const chain = resolveConfiguredChain(this.config, chainId)
    return chain
      ? {
          id: chain.id,
          name: chain.name,
        }
      : undefined
  }

  async balance(options: { address?: `0x${string}`; chainId?: number }) {
    const address = options.address ?? this.config.porto?.address
    if (!address) {
      throw new AppError('MISSING_ACCOUNT_ADDRESS', 'No account address configured. Run `agent-wallet configure` first.')
    }

    const chain = resolveConfiguredChain(this.config, options.chainId)
    if (!chain) {
      throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
    }

    const rpcUrl = chain.rpcUrls.default.http[0]
    if (!rpcUrl) {
      throw new AppError('MISSING_RPC_URL', 'No default RPC URL is configured for the selected chain.', {
        chainId: chain.id,
      })
    }

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    const balanceWei = await publicClient.getBalance({ address })

    return {
      address,
      chainId: chain.id,
      chainName: chain.name,
      wei: balanceWei.toString(),
      formatted: formatEther(balanceWei),
      symbol: chain.nativeCurrency.symbol,
    }
  }

  async deployment(options: { address?: `0x${string}`; chainId?: number }) {
    const address = options.address ?? this.config.porto?.address
    if (!address) {
      throw new AppError('MISSING_ACCOUNT_ADDRESS', 'No account address configured. Run `agent-wallet configure` first.')
    }

    const chain = resolveConfiguredChain(this.config, options.chainId)
    if (!chain) {
      throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
    }

    const rpcUrl = chain.rpcUrls.default.http[0]
    if (!rpcUrl) {
      throw new AppError('MISSING_RPC_URL', 'No default RPC URL is configured for the selected chain.', {
        chainId: chain.id,
      })
    }

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    const bytecode = await publicClient.getCode({
      address,
    })

    return {
      address,
      chainId: chain.id,
      chainName: chain.name,
      deployed: Boolean(bytecode && bytecode !== '0x'),
      bytecodeLength: bytecode ? (bytecode.length - 2) / 2 : 0,
    }
  }
}
