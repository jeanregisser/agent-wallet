import { Command } from 'commander'
import { AppError } from '../lib/errors.js'
import { runCommandAction } from '../lib/command.js'
import { saveConfig, type AgentWalletConfig } from '../lib/config.js'
import type { PortoService } from '../porto/service.js'

type SignOptions = {
  address?: `0x${string}`
  calls: string
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
  const txHash = payload.txHash
  return [
    'Sign complete',
    `Status: ${String(payload.status ?? 'unknown')}`,
    `Transaction: ${typeof txHash === 'string' ? txHash : 'pending (not yet mined)'}`,
    `Bundle ID: ${String(payload.bundleId ?? 'n/a')}`,
  ].join('\n')
}

export function registerSignCommand(program: Command, deps: { config: AgentWalletConfig; porto: PortoService }) {
  const { config, porto } = deps

  const cmd = program
    .command('sign')
    .description('Sign and submit prepared calls using the local hardware-backed agent key')
    .requiredOption('--calls <json>', 'Calls JSON payload')
    .option('--chain-id <id>', 'Chain ID override')
    .option('--address <address>', 'Account address override')

  cmd.action((options: SignOptions) =>
    runCommandAction(cmd, 'json', async (_mode) => {
      const result = await porto.send({
        address: options.address,
        calls: options.calls,
        chainId: parseChainId(options.chainId),
      })
      saveConfig(config)
      return { command: 'sign', poweredBy: 'Porto', ...result }
    }, renderHuman),
  )
}
