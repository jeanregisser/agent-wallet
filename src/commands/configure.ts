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

type ConfigureOptions = {
  createAccount?: boolean
  dialog?: string
  testnet?: boolean
  to?: `0x${string}`[]
}

const TOTAL_STEPS = 2

// ── Error handling ────────────────────────────────────────────────────────────

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

function makeStepError(checkpoint: ConfigureCheckpointName, error: unknown) {
  const appError = toAppError(error)
  return new AppError(appError.code, appError.message, {
    ...appError.details,
    checkpoint,
    nextAction: nextActionForError(checkpoint, appError),
  })
}

// ── Progress logging (stderr) ─────────────────────────────────────────────────

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

function logStepFailure(checkpoint: ConfigureCheckpointName, error: AppError) {
  process.stderr.write(
    [
      `Result: FAILED (${error.code})`,
      `Error: ${error.message}`,
      `Next: ${nextActionForError(checkpoint, error)}`,
      '',
    ].join('\n'),
  )
}

// ── Config helpers ────────────────────────────────────────────────────────────

function ensurePermissionIdList(config: AgentWalletConfig, permissionId: `0x${string}`) {
  const ids = new Set(config.porto?.permissionIds ?? [])
  ids.add(permissionId)
  config.porto = {
    ...config.porto,
    permissionIds: Array.from(ids) as `0x${string}`[],
  }
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function runAgentKeyStep(signer: SignerService, config: AgentWalletConfig): Promise<ConfigureCheckpoint> {
  logStepStart({
    step: 1,
    title: 'Agent key readiness',
    now: 'Ensure the local Secure Enclave agent key exists and is usable.',
    you: 'No manual action unless macOS asks for keychain/biometric confirmation.',
  })

  try {
    const initialized = await signer.init()
    await signer.getPortoKey()
    saveConfig(config)

    const status = initialized.created ? 'created' : 'already_ok'
    logStepResult({ status, details: `Secure Enclave key ${initialized.created ? 'created' : 'already exists'} (${initialized.keyId}).` })
    return { checkpoint: 'agent_key', status, details: { backend: initialized.backend, keyId: initialized.keyId } }
  } catch (error) {
    const appError = toAppError(error)
    logStepFailure('agent_key', appError)
    throw makeStepError('agent_key', appError)
  }
}

type AccountStepResult = {
  checkpoint: ConfigureCheckpoint
  address: `0x${string}`
  chainId: number | undefined
  permissionId: `0x${string}` | undefined
}

async function runAccountStep(
  porto: PortoService,
  config: AgentWalletConfig,
  options: ConfigureOptions,
): Promise<AccountStepResult> {
  logStepStart({
    step: 2,
    title: 'Account & permissions',
    now: 'Connect or create account and grant agent permissions.',
    you: 'Approve the passkey and permissions in your browser dialog.',
  })

  try {
    const hadAddress = Boolean(config.porto?.address)
    const shouldOnboard = Boolean(options.createAccount) || !config.porto?.address

    let address: `0x${string}`
    let chainId: number | undefined
    let permissionId: `0x${string}` | undefined
    let status: ConfigureCheckpointStatus
    let summary: string

    if (shouldOnboard) {
      const onboardResult = await porto.onboard({
        callTargets: options.to,
        createAccount: options.createAccount,
        dialogHost: options.dialog,
        testnet: options.testnet,
      })
      address = onboardResult.address
      chainId = onboardResult.chainId
      permissionId = onboardResult.grantedPermission?.id
      status = hadAddress ? 'updated' : 'created'
      summary = `Account ready at ${address} on chain ${String(chainId)}.`

      if (permissionId) ensurePermissionIdList(config, permissionId)
      saveConfig(config)
    } else {
      address = config.porto!.address!
      chainId = config.porto?.chainId

      // Existing account: check for an active permission before re-granting.
      const active = await porto.activePermission({ address, chainId })
      if (active) {
        permissionId = active.permissionId
        status = 'already_ok'
        summary = `Account and active permission already configured (${active.permissionId}).`
        ensurePermissionIdList(config, permissionId)
        saveConfig(config)
      } else {
        // No active permission: grant with defaults.
        const grantResult = await porto.grant({ address, callTargets: options.to, chainId })
        permissionId = grantResult.permissionId
        status = 'updated'
        summary = `Permission granted (${permissionId}).`
        ensurePermissionIdList(config, permissionId)
        saveConfig(config)
      }
    }

    logStepResult({ status, details: summary })
    return { checkpoint: { checkpoint: 'account', status, details: { address, chainId, permissionId } }, address, chainId, permissionId }
  } catch (error) {
    const appError = toAppError(error)
    logStepFailure('account', appError)
    throw makeStepError('account', appError)
  }
}

// ── Flow orchestration ────────────────────────────────────────────────────────

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

  process.stderr.write('Configure wallet (local-admin setup)\nPowered by Porto\n\n')

  const agentKeyCheckpoint = await runAgentKeyStep(signer, config)
  const accountResult = await runAccountStep(porto, config, options)

  return {
    account: { address: accountResult.address, chainId: accountResult.chainId ?? config.porto?.chainId },
    activation: {
      state: 'granted',
      ...(accountResult.permissionId ? { permissionId: accountResult.permissionId } : {}),
    },
    checkpoints: [agentKeyCheckpoint, accountResult.checkpoint],
    command: 'configure',
    poweredBy: 'Porto',
    setupMode: 'local-admin',
  }
}

// ── Human renderer ────────────────────────────────────────────────────────────

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

// ── Command registration ──────────────────────────────────────────────────────

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
