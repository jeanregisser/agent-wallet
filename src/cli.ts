import { Command } from 'commander'
import { toFunctionSelector } from 'viem'
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
import { closeWalletSession, PortoService } from './porto/service.js'
import { SignerService } from './signer/service.js'

type ConfigureCheckpointName =
  | 'account'
  | 'agent_key'
  | 'permission_state'
  | 'permission_preparation'
  | 'permission_classification'
  | 'outcome'

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
}

type StatusCommandOptions = {
  address?: `0x${string}`
  chainId?: string
}

const DEFAULT_PERMISSION_PER_TX_USD = 25
const DEFAULT_PERMISSION_DAILY_USD = 100
const PORTO_ANY_SELECTOR = '0x32323232'
const PORTO_ANY_TARGET = '0x3232323232323232323232323232323232323232'
const PERMISSION_DISCOVERY_TIMEOUT_MS = 12_000
const PERMISSION_DISCOVERY_INTERVAL_MS = 1_000
const CONFIGURE_STATE_DISCOVERY_TIMEOUT_MS = 12_000
const CONFIGURE_TOTAL_PHASES = 3
const CONFIGURE_TOTAL_STEPS = 6

type PermissionActivationState = 'active_onchain' | 'pending_activation'
type PermissionSnapshot = Awaited<ReturnType<PortoService['permissions']>>['permissions'][number]
type PendingPermissionState = NonNullable<NonNullable<AgentWalletConfig['porto']>['pendingPermission']>

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

function isBroadSelfCallEntry(entry: GrantCallPermission, account: `0x${string}`) {
  const target = entry.to?.toLowerCase()
  if (!target) return false
  if (target !== account.toLowerCase()) return false

  const signature = entry.signature?.toLowerCase()
  if (!signature) return true
  return signature === PORTO_ANY_SELECTOR
}

function allowlistHasBroadSelfCall(
  allowlist: readonly GrantCallPermission[],
  account: `0x${string}`,
) {
  return allowlist.some((entry) => isBroadSelfCallEntry(entry, account))
}

function assertSecureAllowlist(
  allowlist: readonly GrantCallPermission[],
  account: `0x${string}`,
) {
  if (!allowlistHasBroadSelfCall(allowlist, account)) return

  throw new AppError(
    'INSECURE_SELF_ALLOWLIST',
    'Allowlist includes insecure broad self-call scope (`to` set to account without a specific selector).',
    {
      account,
      hint: 'Remove broad self-call entries. Keep only explicit external targets and specific function signatures.',
    },
  )
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

function isActivePermission(permission: { expiry: number }, nowSeconds: number) {
  return permission.expiry > nowSeconds
}

function isHexSelector(value: string | undefined) {
  return Boolean(value && /^0x[0-9a-fA-F]{8}$/.test(value))
}

function permissionMatchesRequestedAllowlist(
  permission: {
    permissions: {
      calls?: readonly GrantCallPermission[]
    }
  },
  requestedAllowlist: readonly GrantCallPermission[],
) {
  const calls = permission.permissions.calls ?? []
  if (requestedAllowlist.length !== calls.length) {
    return false
  }

  const normalize = (entry: GrantCallPermission) => {
    const toRaw = entry.to?.toLowerCase()
    const to = !toRaw || toRaw === PORTO_ANY_TARGET ? '*' : toRaw
    const signatureRaw = entry.signature?.toLowerCase()
    const signature = (() => {
      if (!signatureRaw) return '*'
      if (signatureRaw === PORTO_ANY_SELECTOR) return '*'
      if (isHexSelector(signatureRaw)) return signatureRaw
      try {
        return toFunctionSelector(signatureRaw).toLowerCase()
      } catch {
        return signatureRaw
      }
    })()
    return `${to}|${signature}`
  }

  const actual = calls.map(normalize).sort()
  const expected = requestedAllowlist.map(normalize).sort()
  return expected.every((entry, index) => actual[index] === entry)
}

function permissionMatchesDefaultEnvelope(
  permission: {
    permissions: {
      calls?: readonly GrantCallPermission[]
      spend?: readonly {
        limit: bigint | number | string
        period: string
      }[]
    }
  },
  requestedAllowlist: readonly GrantCallPermission[],
) {
  return (
    permissionMatchesRequestedAllowlist(permission, requestedAllowlist) &&
    includesDailySpendLimit(permission)
  )
}

function currentPendingPermission(config: AgentWalletConfig, chainId?: number) {
  const pending = config.porto?.pendingPermission
  if (!pending) return undefined
  if (typeof chainId === 'number' && pending.chainId !== chainId) return undefined
  return pending
}

function makeCheckpointFailure(
  checkpoint: ConfigureCheckpointName,
  error: unknown,
  checkpoints: ConfigureCheckpoint[],
  nextAction?: string,
) {
  const appError = toAppError(error)
  const resolvedNextAction = nextAction ?? nextActionForConfigureError(checkpoint, appError)
  const failedCheckpoint: ConfigureCheckpoint = {
    checkpoint,
    status: 'failed',
    details: {
      code: appError.code,
      message: appError.message,
      nextAction: resolvedNextAction,
      ...appError.details,
    },
  }

  const allCheckpoints = [...checkpoints, failedCheckpoint]

  return new AppError(appError.code, appError.message, {
    ...appError.details,
    checkpoint,
    checkpoints: allCheckpoints,
    nextAction: resolvedNextAction,
  })
}

function readErrorHint(details: Record<string, unknown> | undefined) {
  const hint = details?.hint
  if (typeof hint !== 'string') return undefined
  return hint.trim().length > 0 ? hint : undefined
}

function nextActionForConfigureError(checkpoint: ConfigureCheckpointName, error: AppError) {
  const hint = readErrorHint(error.details)
  if (hint) return hint

  switch (error.code) {
    case 'CONFIGURE_HUMAN_ONLY':
      return 'Re-run `agent-wallet configure` without --json.'
    case 'NON_INTERACTIVE_REQUIRES_FLAGS':
      return 'Re-run with --headless (or run from an interactive terminal).'
    case 'MISSING_CALL_ALLOWLIST':
      return 'Re-run with --calls \'[{"to":"0x..."}]\' to define the default allowlist.'
    case 'PORTO_LOCAL_RELAY_BIND_FAILED':
      return 'Allow local loopback binding for Porto CLI relay, then re-run configure.'
    case 'PERMISSION_NOT_FINALIZED':
      return 'Re-run configure with --calls to prepare permissions again, then run an allowlisted sign call.'
    case 'MISSING_ACCOUNT_ADDRESS':
      return 'Re-run configure and complete the account step in the dialog.'
    case 'MISSING_CHAIN_ID':
      return 'Re-run configure with explicit network selection (for example: --testnet).'
    case 'INVALID_CALLS_JSON':
      return 'Fix the --calls JSON payload and re-run configure.'
    case 'PORTO_SEND_PREPARE_FAILED':
      return 'Re-run configure. If this repeats, enable debug logs and inspect send output.'
    case 'INSECURE_SELF_ALLOWLIST':
      return 'Remove broad self-call entries and re-run configure with a strict external allowlist.'
    case 'INSECURE_ACTIVE_PERMISSION':
      return 'Re-run configure with --calls to prepare a safe permission envelope without broad self-call scope.'
    default:
      if (checkpoint === 'permission_state') {
        return 'Resolve account/permission state issues above, then re-run configure.'
      }
      if (checkpoint === 'permission_preparation' || checkpoint === 'permission_classification') {
        return 'Retry configure and complete the permission grant/approval dialog if prompted.'
      }
      if (checkpoint === 'outcome') {
        return 'Re-run configure, then use `agent-wallet sign` to activate pending permissions onchain if needed.'
      }
      return 'Fix the issue above, then re-run `agent-wallet configure`.'
  }
}

function logConfigureStepStart(
  mode: OutputMode,
  options: {
    now: string
    phase: number
    phaseTitle: string
    step: number
    title: string
    you: string
  },
) {
  if (mode !== 'human') return

  const lines = [
    `[Phase ${String(options.phase)}/${String(CONFIGURE_TOTAL_PHASES)}] ${options.phaseTitle}`,
    `[Step ${String(options.step)}/${String(CONFIGURE_TOTAL_STEPS)}] ${options.title}`,
    `Now: ${options.now}`,
    `You: ${options.you}`,
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

function logConfigureStepResult(
  mode: OutputMode,
  options: {
    details?: string
    status: ConfigureCheckpointStatus
  },
) {
  if (mode !== 'human') return

  const result =
    options.status === 'failed'
      ? 'FAILED'
      : options.status === 'skipped'
        ? 'SKIPPED'
        : 'SUCCESS'

  const lines = [`Result: ${result} (${options.status})`]
  if (options.details) {
    lines.push(`Details: ${options.details}`)
  }
  process.stdout.write(lines.join('\n') + '\n\n')
}

function logConfigureStepFailure(
  mode: OutputMode,
  options: {
    error: AppError
    nextAction: string
  },
) {
  if (mode !== 'human') return

  process.stdout.write(
    [
      `Result: FAILED (${options.error.code})`,
      `Error: ${options.error.message}`,
      `Next: ${options.nextAction}`,
      '',
    ].join('\n'),
  )
}

function ensurePermissionIdList(config: AgentWalletConfig, permissionId: `0x${string}`) {
  const ids = new Set(config.porto?.permissionIds ?? [])
  ids.add(permissionId)

  config.porto = {
    ...config.porto,
    permissionIds: Array.from(ids) as `0x${string}`[],
  }
}

function formatPermissionExpiry(expiry: number) {
  return {
    expiry,
    expiresAt: new Date(expiry * 1_000).toISOString(),
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function waitForActivePermission(
  porto: PortoService,
  options: {
    address: `0x${string}`
    chainId?: number
    intervalMs?: number
    timeoutMs?: number
  },
) {
  const timeoutMs = options.timeoutMs ?? PERMISSION_DISCOVERY_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? PERMISSION_DISCOVERY_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  while (true) {
    const permissionSet = await porto.permissions({
      address: options.address,
      chainId: options.chainId,
    })
    const nowSeconds = Math.floor(Date.now() / 1_000)
    const active = permissionSet.permissions
      .filter((permission) => isActivePermission(permission, nowSeconds))
      .sort((left, right) => right.expiry - left.expiry)
    const [permission] = active

    if (permission) {
      return permission
    }

    if (Date.now() >= deadline) {
      return null
    }

    await sleep(intervalMs)
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
  const activation = payload.activation as
    | {
        state?: string
        permissionId?: string
        pending?: {
          id?: string
          createdAt?: string
        }
      }
    | undefined

  lines.push(`Account: ${account?.address ?? 'not configured'}`)
  if (account?.chainId) {
    lines.push(`Chain ID: ${account.chainId}`)
  }
  lines.push(`Activation state: ${activation?.state ?? 'unknown'}`)
  if (activation?.permissionId) {
    lines.push(`Permission ID: ${activation.permissionId}`)
  }
  if (activation?.state === 'pending_activation' && activation?.pending?.id) {
    lines.push(`Pending precall: ${activation.pending.id}`)
    if (activation.pending.createdAt) {
      lines.push(`Pending since: ${activation.pending.createdAt}`)
    }
    lines.push('Next: Run your first allowlisted `agent-wallet sign` call to activate onchain.')
  }

  return lines.join('\n')
}

function renderSignHuman({ payload }: { payload: Record<string, unknown> }) {
  const lines = ['Sign complete']
  const txHash = payload.txHash
  lines.push(`Status: ${String(payload.status ?? 'unknown')}`)
  lines.push(`Transaction: ${typeof txHash === 'string' ? txHash : 'pending (not yet mined)'}`)
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
  const activation = payload.activation as
    | {
        state?: string
        pending?: {
          id?: string
          createdAt?: string
        }
      }
    | undefined

  const lines = ['Status']
  lines.push(`Account: ${account?.address ?? 'not configured'}`)
  lines.push(`Chain: ${account?.chainName ?? 'unknown'} (${String(account?.chainId ?? 'n/a')})`)
  lines.push(`Signer: ${signer?.backend ?? 'unknown'} (${signer?.exists ? 'ready' : 'missing'})`)
  lines.push(`Activation: ${activation?.state ?? 'unknown'}`)
  lines.push(
    `Permissions: ${String(permissions?.active ?? 0)} active / ${String(permissions?.total ?? 0)} total`,
  )
  if (activation?.state === 'pending_activation' && activation.pending?.id) {
    lines.push(`Pending permission: ${activation.pending.id}`)
    if (activation.pending.createdAt) {
      lines.push(`Pending since: ${activation.pending.createdAt}`)
    }
  }

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

type ConfigureStepResult = {
  details?: Record<string, unknown>
  status: ConfigureCheckpointStatus
  summary: string
}

async function runConfigureStep(parameters: {
  checkpoint: ConfigureCheckpointName
  checkpoints: ConfigureCheckpoint[]
  mode: OutputMode
  now: string
  phase: number
  phaseTitle: string
  run: () => Promise<ConfigureStepResult>
  step: number
  title: string
  you: string
}) {
  const { checkpoint, checkpoints, mode } = parameters
  logConfigureStepStart(mode, {
    now: parameters.now,
    phase: parameters.phase,
    phaseTitle: parameters.phaseTitle,
    step: parameters.step,
    title: parameters.title,
    you: parameters.you,
  })

  try {
    const result = await parameters.run()
    checkpoints.push({
      checkpoint,
      status: result.status,
      ...(result.details ? { details: result.details } : {}),
    })
    logConfigureStepResult(mode, {
      details: result.summary,
      status: result.status,
    })
    return result
  } catch (error) {
    const appError = toAppError(error)
    const nextAction = nextActionForConfigureError(checkpoint, appError)
    logConfigureStepFailure(mode, {
      error: appError,
      nextAction,
    })
    throw makeCheckpointFailure(checkpoint, appError, checkpoints, nextAction)
  }
}

async function runConfigureFlow(parameters: {
  config: AgentWalletConfig
  mode: OutputMode
  options: ConfigureCommandOptions
  porto: PortoService
  signer: SignerService
}) {
  const { config, mode, options, porto, signer } = parameters

  if (mode !== 'human') {
    throw new AppError('CONFIGURE_HUMAN_ONLY', 'The `configure` command supports human output only. Re-run without --json.')
  }

  const checkpoints: ConfigureCheckpoint[] = []
  let address = config.porto?.address
  let chainId = config.porto?.chainId
  const requestedCallAllowlist: readonly GrantCallPermission[] | undefined = options.calls
    ? parseCallsAllowlist(options.calls)
    : undefined
  let requiresGrant = false
  let grantedPermissionId: `0x${string}` | undefined
  let activePermission: PermissionSnapshot | null = null
  let pendingPermission: PendingPermissionState | undefined
  let activationState: PermissionActivationState = 'pending_activation'
  let permissionUpdated = false

  process.stdout.write('Configure wallet (local-admin setup)\n')
  process.stdout.write('Powered by Porto\n\n')

  await runConfigureStep({
    checkpoint: 'agent_key',
    checkpoints,
    mode,
    now: 'Ensure the local Secure Enclave agent key exists and is usable.',
    phase: 1,
    phaseTitle: 'Account & Key',
    run: async () => {
      const initialized = await signer.init()
      await signer.getPortoKey()
      saveConfig(config)
      return {
        details: {
          backend: initialized.backend,
          keyId: initialized.keyId,
        },
        status: initialized.created ? 'created' : 'already_ok',
        summary: `Secure Enclave key ${initialized.created ? 'created' : 'already exists'} (${initialized.keyId}).`,
      }
    },
    step: 1,
    title: 'Agent key readiness',
    you: 'No manual action unless macOS asks for keychain/biometric confirmation.',
  })

  await runConfigureStep({
    checkpoint: 'account',
    checkpoints,
    mode,
    now: 'Connect or create a smart account and grant agent permissions.',
    phase: 1,
    phaseTitle: 'Account & Key',
    run: async () => {
      const hadConfiguredAccount = Boolean(address)
      const shouldOnboard = Boolean(options.createAccount) || !address
      if (shouldOnboard) {
        const spendLimit = parseSpendLimit(options.spendLimit) ?? config.porto?.defaults?.perTxUsd ?? DEFAULT_PERMISSION_PER_TX_USD
        const onboardResult = await porto.onboard({
          createAccount: options.createAccount,
          dialogHost: options.dialog,
          headless: options.headless,
          nonInteractive: !isInteractive(),
          testnet: options.testnet,
          ...(requestedCallAllowlist
            ? {
                grantOptions: {
                  calls: JSON.stringify(requestedCallAllowlist),
                  defaults: true,
                  expiry: options.expiry,
                  spendLimit,
                },
              }
            : {}),
        })
        address = onboardResult.address
        chainId = onboardResult.chainId

        if (onboardResult.grantedPermission && requestedCallAllowlist) {
          const { id: permissionId, expiry } = onboardResult.grantedPermission
          const resolvedChainId = chainId ?? config.porto?.chainId
          if (!resolvedChainId) {
            throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
          }
          assertSecureAllowlist(requestedCallAllowlist, address)
          grantedPermissionId = permissionId
          permissionUpdated = true
          ensurePermissionIdList(config, permissionId)
          config.porto = {
            ...config.porto,
            permissionIds: config.porto?.permissionIds ?? [],
            pendingPermission: {
              id: permissionId,
              chainId: resolvedChainId,
              createdAt: new Date().toISOString(),
              expiry,
              calls: requestedCallAllowlist.map((entry) => ({
                ...(entry.to ? { to: entry.to } : {}),
                ...(entry.signature ? { signature: entry.signature } : {}),
              })),
            },
          }
        }

        saveConfig(config)
        return {
          details: {
            address,
            chainId,
          },
          status: hadConfiguredAccount ? 'updated' : 'created',
          summary: `Account ready at ${address} on chain ${String(chainId)}.`,
        }
      }

      return {
        details: {
          address,
          chainId,
        },
        status: 'already_ok',
        summary: `Using configured account ${address}.`,
      }
    },
    step: 2,
    title: 'Account & permissions',
    you: 'Approve the passkey and permissions in your browser dialog.',
  })

  if (!address) {
    throw makeCheckpointFailure(
      'account',
      new AppError('MISSING_ACCOUNT_ADDRESS', 'No account is configured. Run `agent-wallet configure` again.'),
      checkpoints,
    )
  }
  const configuredAddress: `0x${string}` = address

  await runConfigureStep({
    checkpoint: 'permission_state',
    checkpoints,
    mode,
    now: 'Inspect onchain and pending permission state for this agent key.',
    phase: 2,
    phaseTitle: 'Permissions',
    run: async () => {
      if (requestedCallAllowlist) {
        assertSecureAllowlist(requestedCallAllowlist, configuredAddress)
      }
      activePermission = await waitForActivePermission(porto, {
        address: configuredAddress,
        chainId,
        timeoutMs: CONFIGURE_STATE_DISCOVERY_TIMEOUT_MS,
      })
      pendingPermission = currentPendingPermission(config, chainId)

      if (
        pendingPermission &&
        allowlistHasBroadSelfCall(pendingPermission.calls, configuredAddress)
      ) {
        if (config.porto?.pendingPermission) {
          delete config.porto.pendingPermission
          saveConfig(config)
        }
        pendingPermission = undefined
      }

      if (
        activePermission &&
        allowlistHasBroadSelfCall(activePermission.permissions.calls, configuredAddress)
      ) {
        if (!requestedCallAllowlist) {
          throw new AppError(
            'INSECURE_ACTIVE_PERMISSION',
            'Active onchain permission contains broad self-call scope.',
            {
              permissionId: activePermission.id,
              hint: 'Re-run with --calls to prepare a safe permission envelope without broad self-call scope.',
            },
          )
        }
        activePermission = null
      }

      if (!requestedCallAllowlist && !activePermission && !pendingPermission) {
        throw new AppError(
          'MISSING_CALL_ALLOWLIST',
          'Missing required flag --calls with at least one allowlisted target for first-time configure.',
          {
            hint: 'Re-run with --calls \'[{"to":"0x..."}]\' to establish the default permission envelope.',
          },
        )
      }

      if (requestedCallAllowlist && activePermission) {
        const activeMatchesRequested = permissionMatchesDefaultEnvelope(
          activePermission,
          requestedCallAllowlist,
        )
        if (activeMatchesRequested) {
          activationState = 'active_onchain'
          grantedPermissionId = activePermission.id
          ensurePermissionIdList(config, activePermission.id)
          if (config.porto?.pendingPermission) {
            delete config.porto.pendingPermission
          }
          saveConfig(config)
          return {
            details: {
              permissionId: activePermission.id,
              state: activationState,
            },
            status: 'already_ok',
            summary: `Requested permission already active onchain (${activePermission.id}).`,
          }
        }
      }

      if (requestedCallAllowlist && pendingPermission) {
        const pendingMatchesRequested = permissionMatchesDefaultEnvelope(
          {
            permissions: {
              calls: pendingPermission.calls,
              spend: [{ limit: BigInt(Math.round(DEFAULT_PERMISSION_DAILY_USD * 1_000_000)), period: 'day' }],
            },
          },
          requestedCallAllowlist,
        )
        if (pendingMatchesRequested) {
          activationState = 'pending_activation'
          grantedPermissionId = pendingPermission.id
          ensurePermissionIdList(config, pendingPermission.id)
          saveConfig(config)
          return {
            details: {
              permissionId: pendingPermission.id,
              state: activationState,
            },
            status: 'already_ok',
            summary: `Requested permission already prepared and pending activation (${pendingPermission.id}).`,
          }
        }
      }

      requiresGrant = Boolean(requestedCallAllowlist)

      if (activePermission) {
        grantedPermissionId = activePermission.id
        ensurePermissionIdList(config, activePermission.id)
        saveConfig(config)
        return {
          details: {
            permissionId: activePermission.id,
            state: 'active_onchain',
          },
          status: 'already_ok',
          summary: `Active onchain permission detected (${activePermission.id}).`,
        }
      }

      if (pendingPermission) {
        grantedPermissionId = pendingPermission.id
        ensurePermissionIdList(config, pendingPermission.id)
        saveConfig(config)
        return {
          details: {
            permissionId: pendingPermission.id,
            state: 'pending_activation',
          },
          status: 'updated',
          summary: `Pending permission found (${pendingPermission.id}); waiting for first matching send.`,
        }
      }

      return {
        details: {
          reason: 'Requested permission differs from current state and will be prepared.',
        },
        status: 'updated',
        summary: 'Requested permission changes detected; preparing a new precall grant.',
      }
    },
    step: 3,
    title: 'Permission state discovery',
    you: 'No action unless the dialog prompts for account/passkey confirmation.',
  })

  await runConfigureStep({
    checkpoint: 'permission_preparation',
    checkpoints,
    mode,
    now: 'Prepare permissions via Porto precall grant when needed.',
    phase: 2,
    phaseTitle: 'Permissions',
    run: async () => {
      if (!requiresGrant) {
        return {
          details: {
            reason: 'No new grant needed.',
          },
          status: 'already_ok',
          summary: 'Authorization step skipped; existing active or pending state is sufficient.',
        }
      }

      if (!requestedCallAllowlist) {
        throw new AppError(
          'MISSING_CALL_ALLOWLIST',
          'Missing required flag --calls with at least one allowlisted target for first-time configure.',
          {
            hint: 'Re-run with --calls \'[{"to":"0x..."}]\' to establish the default permission envelope.',
          },
        )
      }

      const spendLimit = parseSpendLimit(options.spendLimit) ?? config.porto?.defaults?.perTxUsd ?? DEFAULT_PERMISSION_PER_TX_USD
      const grantResult = await porto.grant({
        address: configuredAddress,
        calls: JSON.stringify(requestedCallAllowlist),
        chainId,
        defaults: true,
        expiry: options.expiry,
        spendLimit,
      })

      permissionUpdated = true
      grantedPermissionId = grantResult.permissionId
      const resolvedChainId = chainId ?? config.porto?.chainId
      if (!resolvedChainId) {
        throw new AppError('MISSING_CHAIN_ID', 'No chain configured. Re-run configure with an explicit network.')
      }

      ensurePermissionIdList(config, grantResult.permissionId)
      const nextPermissionIds = config.porto?.permissionIds ?? []
      config.porto = {
        ...config.porto,
        permissionIds: nextPermissionIds,
        pendingPermission: {
          id: grantResult.permissionId,
          chainId: resolvedChainId,
          createdAt: new Date().toISOString(),
          expiry: grantResult.expiry,
          calls: requestedCallAllowlist.map((entry) => ({
            ...(entry.to ? { to: entry.to } : {}),
            ...(entry.signature ? { signature: entry.signature } : {}),
          })),
        },
      }
      saveConfig(config)

      return {
        details: {
          permissionId: grantResult.permissionId,
        },
        status: 'updated',
        summary: `Permission precall prepared (${grantResult.permissionId}).`,
      }
    },
    step: 4,
    title: 'Permission preparation',
    you: 'Approve the permission grant in the browser dialog when prompted.',
  })

  await runConfigureStep({
    checkpoint: 'permission_classification',
    checkpoints,
    mode,
    now: 'Classify state as active onchain or pending activation.',
    phase: 2,
    phaseTitle: 'Permissions',
    run: async () => {
      activePermission = await waitForActivePermission(porto, {
        address: configuredAddress,
        chainId,
        timeoutMs: CONFIGURE_STATE_DISCOVERY_TIMEOUT_MS,
      })
      pendingPermission = currentPendingPermission(config, chainId)
      const desiredAllowlist = requestedCallAllowlist ?? pendingPermission?.calls

      if (activePermission && desiredAllowlist) {
        const desiredActive = permissionMatchesDefaultEnvelope(activePermission, desiredAllowlist)
        if (desiredActive) {
          activationState = 'active_onchain'
        } else {
          activationState = 'pending_activation'
        }
      } else if (activePermission) {
        activationState = 'active_onchain'
      } else {
        activationState = 'pending_activation'
      }

      if (activationState === 'active_onchain' && activePermission) {
        grantedPermissionId = activePermission.id
        ensurePermissionIdList(config, activePermission.id)
        if (config.porto?.pendingPermission) {
          delete config.porto.pendingPermission
        }
        saveConfig(config)
        return {
          details: {
            permissionId: activePermission.id,
            state: activationState,
            ...formatPermissionExpiry(activePermission.expiry),
          },
          status: permissionUpdated ? 'updated' : 'already_ok',
          summary: `Active onchain permission confirmed (${activePermission.id}).`,
        }
      }

      const pending = currentPendingPermission(config, chainId)
      if (!pending && !grantedPermissionId) {
        throw new AppError(
          'PERMISSION_NOT_FINALIZED',
          'No active onchain permission and no pending precall state were found.',
          {
            hint: 'Re-run configure with --calls to prepare permissions again.',
          },
        )
      }

      if (pending?.id) {
        grantedPermissionId = pending.id
      }

      return {
        details: {
          permissionId: grantedPermissionId ?? null,
          state: activationState,
        },
        status: 'updated',
        summary: `Permission is pending activation${grantedPermissionId ? ` (${grantedPermissionId})` : ''}.`,
      }
    },
    step: 5,
    title: 'Permission state classification',
    you: 'No action required.',
  })

  await runConfigureStep({
    checkpoint: 'outcome',
    checkpoints,
    mode,
    now: 'Present the final operator state and next action.',
    phase: 3,
    phaseTitle: 'Outcome',
    run: async () => {
      if (activationState === 'active_onchain') {
        return {
          details: {
            permissionId: grantedPermissionId ?? null,
            state: activationState,
          },
          status: 'already_ok',
          summary: 'Configure state is active onchain.',
        }
      }

      return {
        details: {
          permissionId: grantedPermissionId ?? null,
          state: activationState,
          nextAction:
            'Run your first allowlisted `agent-wallet sign` call to consume the precall and activate onchain.',
        },
        status: 'updated',
        summary:
          'Configure state is pending activation; first matching real send should activate permissions onchain.',
      }
    },
    step: 6,
    title: 'Operator state',
    you: 'If state is pending, run your first allowlisted sign call when ready.',
  })

  const pendingAfterRun = currentPendingPermission(config, chainId)

  return {
    account: {
      address: configuredAddress,
      chainId: chainId ?? config.porto?.chainId,
    },
    activation: {
      state: activationState,
      ...(grantedPermissionId ? { permissionId: grantedPermissionId } : {}),
      ...(pendingAfterRun
        ? {
            pending: {
              id: pendingAfterRun.id,
              createdAt: pendingAfterRun.createdAt,
              chainId: pendingAfterRun.chainId,
            },
          }
        : {}),
    },
    setupMode: 'local-admin',
    checkpoints,
    command: 'configure',
    defaults: {
      dailyUsd: DEFAULT_PERMISSION_DAILY_USD,
      perTxUsd: config.porto?.defaults?.perTxUsd ?? DEFAULT_PERMISSION_PER_TX_USD,
    },
    poweredBy: 'Porto',
  }
}

async function runCommandAction(
  command: Command,
  fallbackMode: OutputMode,
  action: (mode: OutputMode) => Promise<Record<string, unknown>>,
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
      payload = await action(mode)
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
    .description('Configure local-admin account, signer key, and default permission envelope')
    .option('--testnet', 'Use Base Sepolia')
    .option('--dialog <hostname>', 'Dialog host', 'id.porto.sh')
    .option('--headless', 'Allow non-interactive/headless flow')
    .option('--create-account', 'Force creation of a new account')
    .option('--calls <json>', 'Call allowlist JSON for the default permission envelope')
    .option('--expiry <iso8601>', 'Permission expiry timestamp override')
    .option('--spend-limit <usd>', 'Per-transaction nominal USD spend limit override')

  configureCommand.action((options: ConfigureCommandOptions) =>
    runCommandAction(
      configureCommand,
      'human',
      async (mode) =>
        runConfigureFlow({
          config,
          mode,
          options,
          porto,
          signer,
        }),
      renderConfigureHuman,
    ),
  )

  const signCommand = program
    .command('sign')
    .description('Sign and submit prepared calls using the local hardware-backed agent key')
    .requiredOption('--calls <json>', 'Calls JSON payload')
    .option('--chain-id <id>', 'Chain ID override')
    .option('--address <address>', 'Account address override')

  signCommand.action((options: SignCommandOptions) =>
    runCommandAction(
      signCommand,
      'json',
      async (_mode) => {
          const chainId = parseChainId(options.chainId)

          const result = await porto.send({
            address: options.address,
            calls: options.calls,
            chainId,
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
      async (_mode) => {
          const chainId = parseChainId(options.chainId)
          const address = options.address ?? config.porto?.address

          const signerInfo = await signer.info()
          const warnings: Array<{ code: string; message: string }> = []

          let permissionsSummary = {
            active: 0,
            latestExpiry: null as string | null,
            total: 0,
          }
          const pendingPermission = currentPendingPermission(config, chainId)

          if (address) {
            try {
              permissionsSummary = await porto.permissionSummary({
                address,
                chainId,
              })
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
          const activationState =
            permissionsSummary.active > 0
              ? 'active_onchain'
              : pendingPermission
                ? 'pending_activation'
                : 'unconfigured'

        return {
          command: 'status',
          poweredBy: 'Porto',
          account: {
            address: address ?? null,
            chainId: chain?.id ?? chainId ?? config.porto?.chainId ?? null,
            chainName: chain?.name ?? null,
          },
          signer: signerInfo,
          activation: {
            state: activationState,
            ...(pendingPermission
              ? {
                  pending: {
                    id: pendingPermission.id,
                    createdAt: pendingPermission.createdAt,
                    chainId: pendingPermission.chainId,
                  },
                }
              : {}),
          },
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
    closeWalletSession()
    return
  }

  try {
    await program.parseAsync(argv)
  } catch (error) {
    const appError = toAppError(error)
    emitFailure(parseMode, appError)
    process.exitCode = appError.exitCode
  } finally {
    closeWalletSession()
  }
}
