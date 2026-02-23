import { Command } from 'commander'
import type { AgentWalletConfig } from './lib/config.js'
import { loadConfig, saveConfig } from './lib/config.js'
import { AppError, toAppError } from './lib/errors.js'
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

type ConfigureCheckpointName = 'account' | 'agent_key'

type ConfigureCheckpointStatus = 'already_ok' | 'created' | 'updated' | 'skipped' | 'failed'

type ConfigureCheckpoint = {
  checkpoint: ConfigureCheckpointName
  status: ConfigureCheckpointStatus
  details?: Record<string, unknown>
}

type ConfigureCommandOptions = {
  createAccount?: boolean
  dialog?: string
  testnet?: boolean
  to?: `0x${string}`[]
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

const CONFIGURE_TOTAL_STEPS = 2

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

function nextActionForConfigureError(checkpoint: ConfigureCheckpointName, error: AppError) {
  const hint = error.details?.hint
  if (typeof hint === 'string' && hint.trim().length > 0) return hint

  switch (error.code) {
    case 'CONFIGURE_HUMAN_ONLY':
      return 'Re-run `agent-wallet configure` without --json.'
    case 'PORTO_LOCAL_RELAY_BIND_FAILED':
      return 'Allow local loopback binding for Porto CLI relay, then re-run configure.'
    case 'MISSING_ACCOUNT_ADDRESS':
      return 'Re-run configure and complete the account step in the dialog.'
    case 'MISSING_CHAIN_ID':
      return 'Re-run configure with explicit network selection (for example: --testnet).'
    case 'GRANT_FAILED':
      return 'Re-run configure and complete the permission grant in the dialog.'
    default:
      if (checkpoint === 'account') {
        return 'Retry configure and complete the account and permission dialog if prompted.'
      }
      return 'Fix the issue above, then re-run `agent-wallet configure`.'
  }
}

function logConfigureStepStart(
  mode: OutputMode,
  options: {
    now: string
    step: number
    title: string
    you: string
  },
) {
  if (mode !== 'human') return

  const lines = [
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
  run: () => Promise<ConfigureStepResult>
  step: number
  title: string
  you: string
}) {
  const { checkpoint, checkpoints, mode } = parameters
  logConfigureStepStart(mode, {
    now: parameters.now,
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

  // TODO: Allow the user to specify the permission policy (call allowlist, spend limits,
  // expiry) interactively or via flags. See docs/permissions-plan.md for the planned approach.
  // For now, configure grants default permissions: any target, $100/day spend limit, 7-day expiry.

  const checkpoints: ConfigureCheckpoint[] = []
  let address = config.porto?.address
  let chainId = config.porto?.chainId
  let grantedPermissionId: `0x${string}` | undefined

  process.stdout.write('Configure wallet (local-admin setup)\nPowered by Porto\n\n')

  await runConfigureStep({
    checkpoint: 'agent_key',
    checkpoints,
    mode,
    now: 'Ensure the local Secure Enclave agent key exists and is usable.',
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
    now: 'Connect or create account and grant agent permissions.',
    run: async () => {
      const hadAddress = Boolean(address)
      const shouldOnboard = Boolean(options.createAccount) || !address

      if (shouldOnboard) {
        const onboardResult = await porto.onboard({
          callTargets: options.to,
          createAccount: options.createAccount,
          dialogHost: options.dialog,
          testnet: options.testnet,
        })
        address = onboardResult.address
        chainId = onboardResult.chainId

        if (onboardResult.grantedPermission) {
          grantedPermissionId = onboardResult.grantedPermission.id
          ensurePermissionIdList(config, grantedPermissionId)
        }

        saveConfig(config)
        return {
          details: { address, chainId },
          status: hadAddress ? 'updated' : 'created',
          summary: `Account ready at ${address} on chain ${String(chainId)}.`,
        }
      }

      // Existing account: check for an active permission before re-granting.
      const active = await porto.activePermission({ address, chainId })
      if (active) {
        grantedPermissionId = active.permissionId
        ensurePermissionIdList(config, grantedPermissionId)
        saveConfig(config)
        return {
          details: { address, chainId, permissionId: active.permissionId },
          status: 'already_ok',
          summary: `Account and active permission already configured (${active.permissionId}).`,
        }
      }

      // No active permission: grant with defaults.
      const grantResult = await porto.grant({ address, callTargets: options.to, chainId })
      grantedPermissionId = grantResult.permissionId
      ensurePermissionIdList(config, grantedPermissionId)
      saveConfig(config)

      return {
        details: { address, chainId, permissionId: grantedPermissionId },
        status: 'updated',
        summary: `Permission granted (${grantedPermissionId}).`,
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

  return {
    account: {
      address,
      chainId: chainId ?? config.porto?.chainId,
    },
    activation: {
      state: 'granted',
      ...(grantedPermissionId ? { permissionId: grantedPermissionId } : {}),
    },
    checkpoints,
    command: 'configure',
    poweredBy: 'Porto',
    setupMode: 'local-admin',
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
  const activation = payload.activation as { permissionId?: string } | undefined

  lines.push(`Account: ${account?.address ?? 'not configured'}`)
  if (account?.chainId) {
    lines.push(`Chain ID: ${account.chainId}`)
  }
  if (activation?.permissionId) {
    lines.push(`Permission ID: ${activation.permissionId}`)
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

  const activation = payload.activation as { state?: string } | undefined

  const lines = ['Status']
  lines.push(`Account: ${account?.address ?? 'not configured'}`)
  lines.push(`Chain: ${account?.chainName ?? 'unknown'} (${String(account?.chainId ?? 'n/a')})`)
  lines.push(`Signer: ${signer?.backend ?? 'unknown'} (${signer?.exists ? 'ready' : 'missing'})`)
  lines.push(`Activation: ${activation?.state ?? 'unknown'}`)
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
    .description('Configure local-admin account, signer key, and default permissions')
    .option('--testnet', 'Use Base Sepolia')
    .option('--dialog <hostname>', 'Dialog host', 'id.porto.sh')
    .option('--create-account', 'Force creation of a new account')
    .option(
      '--to <address>',
      'Allowed target address (repeatable; omit to allow any target)',
      (val: string, prev: `0x${string}`[]) => [...prev, val as `0x${string}`],
      [] as `0x${string}`[],
    )

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
          const activationState = permissionsSummary.active > 0 ? 'active_onchain' : 'unconfigured'

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
