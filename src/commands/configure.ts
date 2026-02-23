import { Command } from 'commander'
import type { AgentWalletConfig } from '../lib/config.js'
import { saveConfig } from '../lib/config.js'
import { AppError, toAppError } from '../lib/errors.js'
import { runCommandAction } from '../lib/command.js'
import type { OutputMode } from '../lib/output.js'
import type { PortoService } from '../porto/service.js'
import type { SignerService } from '../signer/service.js'

type ConfigureCheckpointName = 'account' | 'agent_key'

type ConfigureCheckpointStatus = 'already_ok' | 'created' | 'updated' | 'skipped' | 'failed'

type ConfigureCheckpoint = {
  checkpoint: ConfigureCheckpointName
  status: ConfigureCheckpointStatus
  details?: Record<string, unknown>
}

type ConfigureStepResult = {
  details?: Record<string, unknown>
  status: ConfigureCheckpointStatus
  summary: string
}

type ConfigureOptions = {
  createAccount?: boolean
  dialog?: string
  testnet?: boolean
  to?: `0x${string}`[]
}

const TOTAL_STEPS = 2

function makeCheckpointFailure(
  checkpoint: ConfigureCheckpointName,
  error: unknown,
  checkpoints: ConfigureCheckpoint[],
  nextAction?: string,
) {
  const appError = toAppError(error)
  const resolvedNextAction = nextAction ?? nextActionForError(checkpoint, appError)
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

  return new AppError(appError.code, appError.message, {
    ...appError.details,
    checkpoint,
    checkpoints: [...checkpoints, failedCheckpoint],
    nextAction: resolvedNextAction,
  })
}

function nextActionForError(checkpoint: ConfigureCheckpointName, error: AppError) {
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

function logStepStart(options: { now: string; step: number; title: string; you: string }) {
  process.stderr.write(
    [
      `[Step ${String(options.step)}/${String(TOTAL_STEPS)}] ${options.title}`,
      `Now: ${options.now}`,
      `You: ${options.you}`,
    ].join('\n') + '\n',
  )
}

function logStepResult(options: { details?: string; status: ConfigureCheckpointStatus }) {
  const label = options.status === 'failed' ? 'FAILED' : options.status === 'skipped' ? 'SKIPPED' : 'SUCCESS'
  const lines = [`Result: ${label} (${options.status})`]
  if (options.details) lines.push(`Details: ${options.details}`)
  process.stderr.write(lines.join('\n') + '\n\n')
}

function logStepFailure(options: { error: AppError; nextAction: string }) {
  process.stderr.write(
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

async function runStep(parameters: {
  checkpoint: ConfigureCheckpointName
  checkpoints: ConfigureCheckpoint[]
  now: string
  run: () => Promise<ConfigureStepResult>
  step: number
  title: string
  you: string
}) {
  const { checkpoint, checkpoints } = parameters
  logStepStart({
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
    logStepResult({ details: result.summary, status: result.status })
    return result
  } catch (error) {
    const appError = toAppError(error)
    const nextAction = nextActionForError(checkpoint, appError)
    logStepFailure({ error: appError, nextAction })
    throw makeCheckpointFailure(checkpoint, appError, checkpoints, nextAction)
  }
}

async function runConfigureFlow(
  mode: OutputMode,
  options: ConfigureOptions,
  config: AgentWalletConfig,
  porto: PortoService,
  signer: SignerService,
) {
  if (mode !== 'human') {
    throw new AppError(
      'CONFIGURE_HUMAN_ONLY',
      'The `configure` command supports human output only. Re-run without --json.',
    )
  }

  // TODO: Allow the user to specify the permission policy (call allowlist, spend limits,
  // expiry) interactively or via flags. See docs/permissions-plan.md for the planned approach.
  // For now, configure grants default permissions: any target, $100/day spend limit, 7-day expiry.

  const checkpoints: ConfigureCheckpoint[] = []
  let address = config.porto?.address
  let chainId = config.porto?.chainId
  let grantedPermissionId: `0x${string}` | undefined

  process.stderr.write('Configure wallet (local-admin setup)\nPowered by Porto\n\n')

  await runStep({
    checkpoint: 'agent_key',
    checkpoints,
    now: 'Ensure the local Secure Enclave agent key exists and is usable.',
    run: async () => {
      const initialized = await signer.init()
      await signer.getPortoKey()
      saveConfig(config)
      return {
        details: { backend: initialized.backend, keyId: initialized.keyId },
        status: initialized.created ? 'created' : 'already_ok',
        summary: `Secure Enclave key ${initialized.created ? 'created' : 'already exists'} (${initialized.keyId}).`,
      }
    },
    step: 1,
    title: 'Agent key readiness',
    you: 'No manual action unless macOS asks for keychain/biometric confirmation.',
  })

  await runStep({
    checkpoint: 'account',
    checkpoints,
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
    account: { address, chainId: chainId ?? config.porto?.chainId },
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

function renderHuman({ payload }: { payload: Record<string, unknown> }) {
  const checkpoints = Array.isArray(payload.checkpoints)
    ? (payload.checkpoints as Array<Record<string, unknown>>)
    : []

  const lines = ['Configure complete', 'Checkpoints:']
  for (const cp of checkpoints) {
    lines.push(`- ${String(cp.checkpoint ?? 'unknown')}: ${String(cp.status ?? 'unknown')}`)
  }

  const account = payload.account as { address?: string; chainId?: number } | undefined
  const activation = payload.activation as { permissionId?: string } | undefined

  lines.push(`Account: ${account?.address ?? 'not configured'}`)
  if (account?.chainId) lines.push(`Chain ID: ${account.chainId}`)
  if (activation?.permissionId) lines.push(`Permission ID: ${activation.permissionId}`)

  return lines.join('\n')
}

export function registerConfigureCommand(
  program: Command,
  deps: { config: AgentWalletConfig; porto: PortoService; signer: SignerService },
) {
  const { config, porto, signer } = deps

  const cmd = program
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

  cmd.action((options: ConfigureOptions) =>
    runCommandAction(cmd, 'human', (mode) => runConfigureFlow(mode, options, config, porto, signer), renderHuman),
  )
}
