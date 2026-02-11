import { Chains, Mode, Porto } from 'porto'
import * as WalletActions from 'porto/viem/WalletActions'
import * as WalletClient from 'porto/viem/WalletClient'
import { waitForCallsStatus } from 'viem/actions'

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
  permissionId?: `0x${string}`
}

type PermissionsOptions = {
  address?: `0x${string}`
}

function getChain(testnet?: boolean) {
  return testnet ? Chains.baseSepolia : Chains.base
}

function normalizeDialogHost(host?: string) {
  return host ?? 'id.porto.sh'
}

async function getWalletClient(options: { dialogHost?: string; testnet?: boolean }) {
  const { cli: createCliDialog } = await import('porto/cli/Dialog')
  const chain = getChain(options.testnet)
  const host = normalizeDialogHost(options.dialogHost)

  const porto = Porto.create({
    announceProvider: false,
    chains: [Chains.base, Chains.baseSepolia],
    mode: Mode.dialog({
      host: new URL('/dialog', `https://${host}`).toString(),
      renderer: await createCliDialog(),
    }),
  })

  return {
    client: WalletClient.fromPorto(porto, {
      chain,
    }),
    close: () => porto.destroy(),
  }
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
    return call
  })
}

export class PortoService {
  constructor(
    private readonly config: AgentWalletConfig,
    private readonly signer: SignerService,
  ) {}

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

      const response = await WalletActions.connect(session.client, {
        chainIds: [chain.id],
        ...(options.createAccount
          ? { createAccount: true }
          : { selectAccount: true }),
      })

      const account = response.accounts[0]
      if (!account?.address) {
        throw new AppError('ONBOARD_FAILED', 'Porto onboarding did not return an account address.')
      }

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

      this.config.porto = {
        ...this.config.porto,
        address: account.address,
        chainId: chain.id,
        dialogHost: normalizeDialogHost(options.dialogHost),
        testnet: Boolean(options.testnet),
        permissionIds: this.config.porto?.permissionIds ?? [],
      }

      return {
        address: account.address,
        chainId: chain.id,
      }
    } finally {
      session?.close()
    }
  }

  async grant(options: GrantOptions) {
    const session = await getWalletClient({
      dialogHost: this.config.porto?.dialogHost,
      testnet: this.config.porto?.testnet,
    })

    try {
      const key = await this.signer.getPortoKey()
      const defaults = Boolean(options.defaults)
      const callPermissions = parseGrantCalls(options.calls, defaults)

      const perTxUsd = options.spendLimit ?? 25
      const dailyUsd = 100

      const response = await WalletActions.grantPermissions(session.client, {
        address: options.address ?? this.config.porto?.address,
        chainId: options.chainId,
        expiry: getUnixExpirySeconds(options.expiry, defaults),
        feeToken: defaults
          ? {
              limit: String(perTxUsd) as `${number}`,
              symbol: 'native',
            }
          : null,
        key,
        permissions: {
          calls: callPermissions,
          ...(defaults
            ? {
                spend: [
                  {
                    limit: BigInt(Math.round(dailyUsd * 1_000_000)),
                    period: 'day' as const,
                  },
                ],
              }
            : {}),
        },
      })

      this.config.porto = {
        ...this.config.porto,
        permissionIds: Array.from(
          new Set([...(this.config.porto?.permissionIds ?? []), response.id]),
        ) as `0x${string}`[],
        latestPermissionId: response.id,
        defaults: defaults
          ? {
              perTxUsd,
              dailyUsd,
              expiryDays: 7,
              allowlistRequired: true,
            }
          : this.config.porto?.defaults,
      }

      return {
        permissionId: response.id,
        expiry: response.expiry,
        key: response.key,
      }
    } finally {
      session.close()
    }
  }

  async send(options: SendOptions) {
    const session = await getWalletClient({
      dialogHost: this.config.porto?.dialogHost,
      testnet: this.config.porto?.testnet,
    })

    try {
      const key = await this.signer.getPortoKey()
      const calls = parseSendCalls(options.calls)
      const permissionId = options.permissionId ?? this.config.porto?.latestPermissionId

      const prepared = await WalletActions.prepareCalls(session.client, {
        calls: calls as any,
        chainId: options.chainId ?? this.config.porto?.chainId,
        from: options.address ?? this.config.porto?.address,
        key,
        capabilities: permissionId
          ? {
              permissions: {
                id: permissionId,
              },
            }
          : undefined,
      })

      const signatureResult = await this.signer.sign(prepared.digest, 'hex', 'none')

      const response = await WalletActions.sendPreparedCalls(session.client, {
        ...prepared,
        signature: signatureResult.signature as `0x${string}`,
      })

      const bundleId = response[0]?.id
      if (!bundleId) {
        throw new AppError('SEND_FAILED', 'Porto did not return a call bundle id.')
      }

      const status = await waitForCallsStatus(session.client, {
        id: bundleId,
        pollingInterval: 1_000,
      })

      const txHash = status.receipts?.[0]?.transactionHash ?? bundleId

      return {
        txHash,
        bundleId,
        status: status.status,
      }
    } finally {
      session.close()
    }
  }

  async permissions(options: PermissionsOptions) {
    const session = await getWalletClient({
      dialogHost: this.config.porto?.dialogHost,
      testnet: this.config.porto?.testnet,
    })

    try {
      const permissions = await WalletActions.getPermissions(session.client, {
        address: options.address ?? this.config.porto?.address,
        chainIds: this.config.porto?.chainId ? [this.config.porto.chainId] : undefined,
      })

      return {
        permissions,
      }
    } finally {
      session.close()
    }
  }
}
