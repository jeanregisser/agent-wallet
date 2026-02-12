import { Command } from 'commander'

import type { AgentWalletConfig } from './lib/config.js'
import { loadConfig, saveConfig } from './lib/config.js'
import { parseJsonFlag } from './lib/encoding.js'
import { AppError, toAppError } from './lib/errors.js'
import { isInteractive } from './lib/interactive.js'
import {
  emitFailure,
  emitSuccess,
  inferOutputModeFromArgv,
  resolveOutputMode,
  type HumanRenderer,
  type OutputMode,
} from './lib/output.js'
import { PortoService } from './porto/service.js'
import { SignerService } from './signer/service.js'

type ConfigureCheckpointName =
  | 'account'
  | 'agent_key'
  | 'authorization'
  | 'permissions'
  | 'deployment'

type ConfigureCheckpointStatus = 'already_ok' | 'created' | 'updated' | 'skipped' | 'failed'

type ConfigureCheckpoint = {
  checkpoint: ConfigureCheckpointName
  status: ConfigureCheckpointStatus
  details?: Record<string, unknown>
}

type GrantCallPermission = {
  signature?: string
  to?: `0x${string}`
}

type ConfigureCommandOptions = {
  calls?: string
  createAccount?: boolean
  deploy?: boolean
  dialog?: string
  expiry?: string
  headless?: boolean
  spendLimit?: string
  testnet?: boolean
}

type SignCommandOptions = {
  address?: `0x${string}`
  calls: string
  chainId?: string
  permissionId?: `0x${string}`
}

type StatusCommandOptions = {
  address?: `0x${string}`
  chainId?: string
}

const DEFAULT_PERMISSION_PER_TX_USD = 25
const DEFAULT_PERMISSION_DAILY_USD = 100

function parseChainId(value?: string) {
  if (!value) return undefined

  const chainId = Number(value)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new AppError('INVALID_CHAIN_ID', 'Chain ID must be a positive integer.', {
      chainId: value,
    })
  }

  return chainId
}

function parseSpendLimit(value?: string) {
  if (!value) return undefined

  const spendLimit = Number(value)
  if (!Number.isFinite(spendLimit) || spendLimit <= 0) {
    throw new AppError('INVALID_SPEND_LIMIT', 'Spend limit must be a positive number.', {
      spendLimit: value,
    })
  }

  return spendLimit
}

function parseExpirySeconds(expiry?: string) {
  if (!expiry) return undefined

  const timestamp = Date.parse(expiry)
  if (Number.isNaN(timestamp)) {
    throw new AppError('INVALID_EXPIRY', 'Expiry must be a valid ISO-8601 timestamp.', {
      expiry,
    })
  }

  return Math.floor(timestamp / 1000)
}

function parseCallsAllowlist(calls: string) {
  const parsed = parseJsonFlag<GrantCallPermission[]>(calls, 'INVALID_CALLS_JSON')
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError('INVALID_CALLS_JSON', 'Calls allowlist must be a non-empty JSON array.')
  }

  return parsed.map((entry) => {
    const normalized: GrantCallPermission = {
      signature: entry.signature,
      to: entry.to,
    }

    if (!normalized.signature && !normalized.to) {
      throw new AppError(
        'INVALID_CALLS_JSON',
        'Each allowlist entry must include at least one of `to` or `signature`.',
      )
    }

    return normalized
  })
}

function normalizeCallPermission(entry: GrantCallPermission) {
  return {
    signature: entry.signature?.toLowerCase() ?? null,
    to: entry.to?.toLowerCase() ?? null,
  }
}

function callPermissionsEqual(
  expected: readonly GrantCallPermission[],
  actual: readonly GrantCallPermission[],
) {
  if (expected.length !== actual.length) return false

  const left = expected
    .map(normalizeCallPermission)
    .sort((a, b) => `${a.to}:${a.signature}`.localeCompare(`${b.to}:${b.signature}`))

  const right = actual
    .map(normalizeCallPermission)
    .sort((a, b) => `${a.to}:${a.signature}`.localeCompare(`${b.to}:${b.signature}`))

  return left.every((entry, index) => {
    const candidate = right[index]
    return candidate && entry.to === candidate.to && entry.signature === candidate.signature
  })
}

function includesDailySpendLimit(permission: {
  permissions: {
    spend?: readonly {
      limit: bigint | number | string
      period: string
    }[]
  }
}) {
  const required = BigInt(Math.round(DEFAULT_PERMISSION_DAILY_USD * 1_000_000))
  const entries = permission.permissions.spend ?? []

  return entries.some((entry) => {
    if (entry.period !== 'day') return false

    const limit = typeof entry.limit === 'bigint' ? entry.limit : BigInt(String(entry.limit))
    return limit === required
  })
}

function matchesAgentKey(
  permission: {
    key: {
      publicKey: string
      type: string
    }
  },
  key: {
    publicKey: string
    type: string
  },
) {
  return (
    permission.key.type === key.type &&
    permission.key.publicKey.toLowerCase() === key.publicKey.toLowerCase()
  )
}

function isActivePermission(permission: { expiry: number }, nowSeconds: number) {
  return permission.expiry > nowSeconds
}

function makeCheckpointFailure(
  checkpoint: ConfigureCheckpointName,
  error: unknown,
  checkpoints: ConfigureCheckpoint[],
) {
  const appError = toAppError(error)
  const failedCheckpoint: ConfigureCheckpoint = {
    checkpoint,
    status: 'failed',
    details: {
      code: appError.code,
      message: appError.message,
    },
  }

  const allCheckpoints = [...checkpoints, failedCheckpoint]

  return new AppError(appError.code, appError.message, {
    ...appError.details,
    checkpoint,
    checkpoints: allCheckpoints,
  })
}

function ensurePermissionIdList(config: AgentWalletConfig, permissionId: `0x${string}`) {
  const ids = new Set(config.porto?.permissionIds ?? [])
  ids.add(permissionId)

  config.porto = {
    ...config.porto,
    permissionIds: Array.from(ids) as `0x${string}`[],
    latestPermissionId: permissionId,
  }
}

function formatPermissionExpiry(expiry: number) {
  return {
    expiry,
    expiresAt: new Date(expiry * 1_000).toISOString(),
  }
}

function renderConfigureHuman({ payload }: { payload: Record<string, unknown> }) {
  const checkpoints = Array.isArray(payload.checkpoints)
    ? (payload.checkpoints as Array<Record<string, unknown>>)
    : []

  const lines = ['Configure complete', 'Checkpoints:']

  for (const checkpoint of checkpoints) {
    const name = String(checkpoint.checkpoint ?? 'unknown')
    const status = String(checkpoint.status ?? 'unknown')
    lines.push(`- ${name}: ${status}`)
  }

  const account = payload.account as { address?: string; chainId?: number } | undefined
  lines.push(`Account: ${account?.address ?? 'not configured'}`)
  if (account?.chainId) {
    lines.push(`Chain ID: ${account.chainId}`)
  }

  return lines.join('\n')
}

function renderSignHuman({ payload }: { payload: Record<string, unknown> }) {
  const lines = ['Sign complete']
  lines.push(`Status: ${String(payload.status ?? 'unknown')}`)
  lines.push(`Transaction: ${String(payload.txHash ?? 'n/a')}`)
  lines.push(`Bundle ID: ${String(payload.bundleId ?? 'n/a')}`)
  return lines.join('\n')
}

function renderStatusHuman({ payload }: { payload: Record<string, unknown> }) {
  const account = payload.account as
    | {
        address?: string | null
        chainId?: number | null
        chainName?: string | null
      }
    | undefined

  const signer = payload.signer as
    | {
        backend?: string
        exists?: boolean
        keyId?: string
      }
    | undefined

  const permissions = payload.permissions as
    | {
        active?: number
        total?: number
        latestExpiry?: string | null
      }
    | undefined

  const balances = Array.isArray(payload.balances)
    ? (payload.balances as Array<Record<string, unknown>>)
    : []

  const warnings = Array.isArray(payload.warnings)
    ? (payload.warnings as Array<Record<string, unknown>>)
    : []

  const lines = ['Status']
  lines.push(`Account: ${account?.address ?? 'not configured'}`)
  lines.push(`Chain: ${account?.chainName ?? 'unknown'} (${String(account?.chainId ?? 'n/a')})`)
  lines.push(`Signer: ${signer?.backend ?? 'unknown'} (${signer?.exists ? 'ready' : 'missing'})`)
  lines.push(
    `Permissions: ${String(permissions?.active ?? 0)} active / ${String(permissions?.total ?? 0)} total`,
  )

  if (permissions?.latestExpiry) {
    lines.push(`Latest permission expiry: ${permissions.latestExpiry}`)
  }

  if (balances.length > 0) {
    lines.push('Balances:')
    for (const balance of balances) {
      lines.push(
        `- ${String(balance.formatted ?? '0')} ${String(balance.symbol ?? '')} on ${String(balance.chainName ?? 'chain')}`,
      )
    }
  }

  if (warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of warnings) {
      lines.push(`- ${String(warning.code ?? 'UNKNOWN')}: ${String(warning.message ?? '')}`)
    }
  }

  return lines.join('\n')
}

async function runCommandAction(
  command: Command,
  fallbackMode: OutputMode,
  action: () => Promise<Record<string, unknown>>,
  humanRenderer?: HumanRenderer,
) {
  let mode = fallbackMode

  try {
    const options = command.optsWithGlobals() as {
      json?: boolean
      human?: boolean
    }

    mode = resolveOutputMode(options, fallbackMode)
    let restoreStdout: (() => void) | undefined
    if (mode === 'json') {
      const originalWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (() => true) as typeof process.stdout.write
      restoreStdout = () => {
        process.stdout.write = originalWrite
      }
    }

    let payload: Record<string, unknown>
    try {
      payload = await action()
    } finally {
      restoreStdout?.()
    }

    emitSuccess(mode, payload, humanRenderer)
  } catch (error) {
    const appError = toAppError(error)
    emitFailure(mode, appError)
    process.exitCode = appError.exitCode
  }
}

export async function runAgentWallet(argv: string[] = process.argv) {
  const config = loadConfig()
  const signer = new SignerService(config)
  const porto = new PortoService(config, signer)

  const program = new Command()
  program
    .name('agent-wallet')
    .description('Security-first agent wallet CLI (powered by Porto)')
    .showHelpAfterError(true)
    .option('--json', 'Machine-readable JSON output')
    .option('--human', 'Human-readable output')

  program.configureOutput({
    writeErr: (str) => {
      throw new AppError('CLI_ARGUMENT_ERROR', str.trim())
    },
  })

  const configureCommand = program
    .command('configure')
    .description('Bootstrap local-admin account, signer key, and default permission envelope')
    .option('--testnet', 'Use Base Sepolia')
    .option('--dialog <hostname>', 'Dialog host', 'id.porto.sh')
    .option('--headless', 'Allow non-interactive/headless flow')
    .option('--create-account', 'Force creation of a new account')
    .option('--calls <json>', 'Call allowlist JSON for the default permission envelope')
    .option('--expiry <iso8601>', 'Permission expiry timestamp override')
    .option('--spend-limit <usd>', 'Per-transaction nominal USD spend limit override')
    .option('--deploy', 'Attempt deployment/init transaction if account bytecode is missing')

  configureCommand.action((options: ConfigureCommandOptions) =>
    runCommandAction(
      configureCommand,
      'human',
      async () => {
          const checkpoints: ConfigureCheckpoint[] = []

          let address = config.porto?.address
          let chainId = config.porto?.chainId

          let grantedPermissionId: `0x${string}` | undefined

          try {
            const hadConfiguredAccount = Boolean(address)
            const shouldOnboard = Boolean(options.createAccount) || !address

            if (shouldOnboard) {
              const onboardResult = await porto.onboard({
                createAccount: options.createAccount,
                dialogHost: options.dialog,
                headless: options.headless,
                nonInteractive: !isInteractive(),
                testnet: options.testnet,
              })

              address = onboardResult.address
              chainId = onboardResult.chainId
              checkpoints.push({
                checkpoint: 'account',
                status: hadConfiguredAccount ? 'updated' : 'created',
                details: {
                  address,
                  chainId,
                },
              })
              saveConfig(config)
            } else {
              checkpoints.push({
                checkpoint: 'account',
                status: 'already_ok',
                details: {
                  address,
                  chainId,
                },
              })
            }
          } catch (error) {
            throw makeCheckpointFailure('account', error, checkpoints)
          }

          try {
            const initialized = await signer.init()
            await signer.getPortoKey()

            checkpoints.push({
              checkpoint: 'agent_key',
              status: initialized.created ? 'created' : 'already_ok',
              details: {
                keyId: initialized.keyId,
                backend: initialized.backend,
              },
            })

            saveConfig(config)
          } catch (error) {
            throw makeCheckpointFailure('agent_key', error, checkpoints)
          }

          if (!address) {
            throw makeCheckpointFailure(
              'account',
              new AppError('MISSING_ACCOUNT_ADDRESS', 'No account is configured. Run `agent-wallet configure` again.'),
              checkpoints,
            )
          }

          const permissionExpiryOverride = parseExpirySeconds(options.expiry)
          const requestedCallAllowlist = options.calls ? parseCallsAllowlist(options.calls) : undefined
          const spendLimitOverride = parseSpendLimit(options.spendLimit)

          try {
            const key = await signer.getPortoKey()
            const permissionResult = await porto.permissions({ address })

            const nowSeconds = Math.floor(Date.now() / 1_000)
            const keyedPermissions = permissionResult.permissions.filter((permission) =>
              matchesAgentKey(permission, key),
            )
            const activeKeyPermissions = keyedPermissions.filter((permission) =>
              isActivePermission(permission, nowSeconds),
            )

            const matchingPermission = activeKeyPermissions.find((permission) => {
              if (permissionExpiryOverride && permission.expiry < permissionExpiryOverride) {
                return false
              }

              if (!includesDailySpendLimit(permission)) {
                return false
              }

              if (!requestedCallAllowlist) {
                return true
              }

              return callPermissionsEqual(requestedCallAllowlist, permission.permissions.calls)
            })

            if (matchingPermission) {
              checkpoints.push({
                checkpoint: 'authorization',
                status: 'already_ok',
                details: {
                  permissionId: matchingPermission.id,
                },
              })

              checkpoints.push({
                checkpoint: 'permissions',
                status: 'already_ok',
                details: {
                  permissionId: matchingPermission.id,
                  ...formatPermissionExpiry(matchingPermission.expiry),
                },
              })

              ensurePermissionIdList(config, matchingPermission.id)
              saveConfig(config)
              grantedPermissionId = matchingPermission.id
            } else {
              if (!requestedCallAllowlist) {
                throw new AppError(
                  'MISSING_CALL_ALLOWLIST',
                  'Missing required flag --calls with at least one allowlisted target for first-time configure.',
                  {
                    hint: 'Re-run with --calls \'[{"to":"0x..."}]\' to establish the default permission envelope.',
                  },
                )
              }

              const spendLimit =
                spendLimitOverride ?? config.porto?.defaults?.perTxUsd ?? DEFAULT_PERMISSION_PER_TX_USD

              const grantResult = await porto.grant({
                address,
                calls: JSON.stringify(requestedCallAllowlist),
                chainId,
                defaults: true,
                expiry: options.expiry,
                spendLimit,
              })

              grantedPermissionId = grantResult.permissionId

              checkpoints.push({
                checkpoint: 'authorization',
                status: activeKeyPermissions.length > 0 ? 'already_ok' : 'updated',
                details: {
                  permissionId: grantResult.permissionId,
                },
              })

              checkpoints.push({
                checkpoint: 'permissions',
                status: activeKeyPermissions.length > 0 ? 'updated' : 'created',
                details: {
                  permissionId: grantResult.permissionId,
                  ...formatPermissionExpiry(grantResult.expiry),
                },
              })

              saveConfig(config)
            }
          } catch (error) {
            throw makeCheckpointFailure('permissions', error, checkpoints)
          }

          if (!options.deploy) {
            checkpoints.push({
              checkpoint: 'deployment',
              status: 'skipped',
              details: {
                reason: 'Not requested (pass --deploy to enable).',
              },
            })
          } else {
            try {
              const before = await porto.deployment({
                address,
                chainId,
              })

              if (before.deployed) {
                checkpoints.push({
                  checkpoint: 'deployment',
                  status: 'already_ok',
                  details: {
                    chainId: before.chainId,
                  },
                })
              } else {
                const permissionId = grantedPermissionId ?? config.porto?.latestPermissionId
                if (!permissionId) {
                  throw new AppError(
                    'MISSING_PERMISSION_ID',
                    'Deployment requested but no active permission ID is available.',
                    {
                      hint: 'Re-run configure with --calls to grant permissions before forcing deployment.',
                    },
                  )
                }

                const sendResult = await porto.send({
                  address,
                  calls: JSON.stringify([
                    {
                      data: '0x',
                      to: address,
                      value: '0x0',
                    },
                  ]),
                  chainId,
                  permissionId,
                })

                const after = await porto.deployment({
                  address,
                  chainId,
                })

                if (!after.deployed) {
                  throw new AppError(
                    'DEPLOYMENT_NOT_CONFIRMED',
                    'Deployment transaction was submitted, but bytecode is still missing onchain.',
                    {
                      txHash: sendResult.txHash,
                    },
                  )
                }

                checkpoints.push({
                  checkpoint: 'deployment',
                  status: 'created',
                  details: {
                    txHash: sendResult.txHash,
                  },
                })
              }
            } catch (error) {
              throw makeCheckpointFailure('deployment', error, checkpoints)
            }
          }

        return {
          command: 'configure',
          poweredBy: 'Porto',
          bootstrapMode: 'local-admin',
          account: {
            address,
            chainId: chainId ?? config.porto?.chainId,
          },
          defaults: {
            dailyUsd: DEFAULT_PERMISSION_DAILY_USD,
            perTxUsd: config.porto?.defaults?.perTxUsd ?? DEFAULT_PERMISSION_PER_TX_USD,
          },
          checkpoints,
        }
      },
      renderConfigureHuman,
    ),
  )

  const signCommand = program
    .command('sign')
    .description('Sign and submit prepared calls using the local hardware-backed agent key')
    .requiredOption('--calls <json>', 'Calls JSON payload')
    .option('--chain-id <id>', 'Chain ID override')
    .option('--address <address>', 'Account address override')
    .option('--permission-id <id>', 'Permission ID override')

  signCommand.action((options: SignCommandOptions) =>
    runCommandAction(
      signCommand,
      'json',
      async () => {
          const chainId = parseChainId(options.chainId)

          const result = await porto.send({
            address: options.address,
            calls: options.calls,
            chainId,
            permissionId: options.permissionId,
          })

        return {
          command: 'sign',
          poweredBy: 'Porto',
          ...result,
        }
      },
      renderSignHuman,
    ),
  )

  const statusCommand = program
    .command('status')
    .description('Inspect account, signer health, permissions, and balances')
    .option('--address <address>', 'Account address override')
    .option('--chain-id <id>', 'Chain ID override')

  statusCommand.action((options: StatusCommandOptions) =>
    runCommandAction(
      statusCommand,
      'human',
      async () => {
          const chainId = parseChainId(options.chainId)
          const address = options.address ?? config.porto?.address

          const signerInfo = await signer.info()
          const warnings: Array<{ code: string; message: string }> = []

          let permissionsSummary = {
            active: 0,
            latestExpiry: null as string | null,
            total: 0,
          }

          if (address) {
            try {
              const permissionResult = await porto.permissions({ address })
              const nowSeconds = Math.floor(Date.now() / 1_000)
              const active = permissionResult.permissions.filter((permission) =>
                isActivePermission(permission, nowSeconds),
              )
              const latestExpiry = active
                .map((permission) => permission.expiry)
                .sort((left, right) => right - left)[0]

              permissionsSummary = {
                active: active.length,
                latestExpiry: latestExpiry ? new Date(latestExpiry * 1_000).toISOString() : null,
                total: permissionResult.permissions.length,
              }
            } catch (error) {
              const appError = toAppError(error)
              warnings.push({
                code: appError.code,
                message: appError.message,
              })
            }
          }

          const balances: Array<Record<string, unknown>> = []
          if (address) {
            try {
              const balance = await porto.balance({
                address,
                chainId,
              })
              balances.push(balance)
            } catch (error) {
              const appError = toAppError(error)
              warnings.push({
                code: appError.code,
                message: appError.message,
              })
            }
          }

          const chain = porto.getChainDetails(chainId)

        return {
          command: 'status',
          poweredBy: 'Porto',
          account: {
            address: address ?? null,
            chainId: chain?.id ?? chainId ?? config.porto?.chainId ?? null,
            chainName: chain?.name ?? null,
          },
          signer: signerInfo,
          permissions: permissionsSummary,
          balances,
          warnings,
        }
      },
      renderStatusHuman,
    ),
  )

  let parseMode: OutputMode = 'human'
  try {
    parseMode = inferOutputModeFromArgv(argv, 'human')
  } catch (error) {
    const appError = toAppError(error)
    emitFailure('human', appError)
    process.exitCode = appError.exitCode
    return
  }

  try {
    await program.parseAsync(argv)
  } catch (error) {
    const appError = toAppError(error)
    emitFailure(parseMode, appError)
    process.exitCode = appError.exitCode
  }
}
