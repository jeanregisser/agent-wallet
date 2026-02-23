import { Command } from 'commander'
import type { AgentWalletConfig } from '../lib/config.js'
import { AppError, toAppError } from '../lib/errors.js'
import { runCommandAction } from '../lib/command.js'
import type { PortoService } from '../porto/service.js'
import type { SignerService } from '../signer/service.js'

type StatusOptions = {
  address?: `0x${string}`
  chainId?: string
}

function parseChainId(value?: string) {
  if (!value) return undefined
  const chainId = Number(value)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new AppError('INVALID_CHAIN_ID', 'Chain ID must be a positive integer.', { chainId: value })
  }
  return chainId
}

function renderHuman({ payload }: { payload: Record<string, unknown> }) {
  const account = payload.account as { address?: string | null; chainId?: number | null; chainName?: string | null } | undefined
  const signer = payload.signer as { backend?: string; exists?: boolean } | undefined
  const permissions = payload.permissions as { active?: number; total?: number; latestExpiry?: string | null } | undefined
  const activation = payload.activation as { state?: string } | undefined
  const balances = Array.isArray(payload.balances) ? (payload.balances as Array<Record<string, unknown>>) : []
  const warnings = Array.isArray(payload.warnings) ? (payload.warnings as Array<Record<string, unknown>>) : []

  const lines = [
    'Status',
    `Account: ${account?.address ?? 'not configured'}`,
    `Chain: ${account?.chainName ?? 'unknown'} (${String(account?.chainId ?? 'n/a')})`,
    `Signer: ${signer?.backend ?? 'unknown'} (${signer?.exists ? 'ready' : 'missing'})`,
    `Activation: ${activation?.state ?? 'unknown'}`,
    `Permissions: ${String(permissions?.active ?? 0)} active / ${String(permissions?.total ?? 0)} total`,
  ]

  if (permissions?.latestExpiry) lines.push(`Latest permission expiry: ${permissions.latestExpiry}`)

  if (balances.length > 0) {
    lines.push('Balances:')
    for (const balance of balances) {
      lines.push(`- ${String(balance.formatted ?? '0')} ${String(balance.symbol ?? '')} on ${String(balance.chainName ?? 'chain')}`)
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

export function registerStatusCommand(
  program: Command,
  deps: { config: AgentWalletConfig; porto: PortoService; signer: SignerService },
) {
  const { config, porto, signer } = deps

  const cmd = program
    .command('status')
    .description('Inspect account, signer health, permissions, and balances')
    .option('--address <address>', 'Account address override')
    .option('--chain-id <id>', 'Chain ID override')

  cmd.action((options: StatusOptions) =>
    runCommandAction(cmd, 'human', async (_mode) => {
      const chainId = parseChainId(options.chainId)
      const address = options.address ?? config.porto?.address
      const warnings: Array<{ code: string; message: string }> = []

      const signerInfo = await signer.info()

      let permissionsSummary = { active: 0, latestExpiry: null as string | null, total: 0 }
      if (address) {
        try {
          permissionsSummary = await porto.permissionSummary({ address, chainId })
        } catch (error) {
          const appError = toAppError(error)
          warnings.push({ code: appError.code, message: appError.message })
        }
      }

      const balances: Array<Record<string, unknown>> = []
      if (address) {
        try {
          balances.push(await porto.balance({ address, chainId }))
        } catch (error) {
          const appError = toAppError(error)
          warnings.push({ code: appError.code, message: appError.message })
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
        activation: { state: activationState },
        permissions: permissionsSummary,
        balances,
        warnings,
      }
    }, renderHuman),
  )
}
