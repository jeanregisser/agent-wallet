import { Command } from 'commander'

import { loadConfig, saveConfig } from './lib/config.js'
import { AppError, toAppError } from './lib/errors.js'
import { isInteractive } from './lib/interactive.js'
import { emitError, emitOk } from './lib/output.js'
import { PortoService } from './porto/service.js'
import { SignerService } from './signer/service.js'

type PromiseAction = () => Promise<void>

async function withJsonHandling(action: PromiseAction) {
  try {
    await action()
  } catch (error) {
    const appError = toAppError(error)
    emitError(appError)
    process.exitCode = appError.exitCode
  }
}

export async function runAgentWallet(argv: string[] = process.argv) {
  const config = loadConfig()
  const signer = new SignerService(config)
  const porto = new PortoService(config, signer)

  const program = new Command()
  program.name('agent-wallet').description('Porto-native agent wallet CLI')
  program.showHelpAfterError(true)
  program.configureOutput({
    writeErr: (str) => {
      throw new AppError('CLI_ARGUMENT_ERROR', str.trim())
    },
  })

  const signerCommand = program.command('signer').description('Secure Enclave signer commands')

  signerCommand
    .command('init')
    .description('Create or reuse a Secure Enclave key')
    .option('--label <label>', 'Human-readable key label')
    .option('--overwrite', 'Replace existing key')
    .action((options: { label?: string; overwrite?: boolean }) =>
      withJsonHandling(async () => {
        const result = await signer.init({
          label: options.label,
          overwrite: options.overwrite,
        })

        if (options.label) config.signer.label = options.label
        saveConfig(config)

        emitOk(result)
      }),
    )

  signerCommand
    .command('pubkey')
    .description('Return signer public key')
    .option('--format <format>', 'raw|hex|jwk|spki', 'jwk')
    .action((options: { format: 'raw' | 'hex' | 'jwk' | 'spki' }) =>
      withJsonHandling(async () => {
        const result = await signer.pubkey(options.format)
        emitOk(result)
      }),
    )

  signerCommand
    .command('sign')
    .description('Sign a payload')
    .argument('<payload>', 'Payload to sign')
    .option('--format <format>', 'hex|base64|raw', 'hex')
    .option('--hash <hash>', 'none|sha256', 'sha256')
    .action((payload: string, options: { format: 'hex' | 'base64' | 'raw'; hash: 'none' | 'sha256' }) =>
      withJsonHandling(async () => {
        const result = await signer.sign(payload, options.format, options.hash)
        emitOk(result)
      }),
    )

  signerCommand
    .command('info')
    .description('Show signer metadata')
    .action(() =>
      withJsonHandling(async () => {
        const result = await signer.info()
        emitOk(result)
      }),
    )

  const portoCommand = program.command('porto').description('Porto adapter commands')

  portoCommand
    .command('onboard')
    .description('Interactive passkey onboarding and account creation')
    .option('--testnet', 'Use Base Sepolia')
    .option('--dialog <hostname>', 'Dialog host', 'id.porto.sh')
    .option('--headless', 'Allow non-interactive/headless flow')
    .option('--create-account', 'Force creation of a new Porto account')
    .action((options: { testnet?: boolean; dialog?: string; headless?: boolean; createAccount?: boolean }) =>
      withJsonHandling(async () => {
        const result = await porto.onboard({
          testnet: options.testnet,
          dialogHost: options.dialog,
          headless: options.headless,
          createAccount: options.createAccount,
          nonInteractive: !isInteractive(),
        })
        saveConfig(config)
        emitOk(result)
      }),
    )

  portoCommand
    .command('grant')
    .description('Grant scoped permissions to the agent key')
    .option('--expiry <iso8601>', 'Permission expiry timestamp')
    .option('--spend-limit <usd>', 'Per-transaction nominal USD spend limit')
    .option('--calls <json>', 'Calls allowlist JSON')
    .option('--address <address>', 'Account address override')
    .option('--chain-id <id>', 'Chain ID override')
    .option('--defaults', 'Apply safe defaults')
    .action(
      (options: {
        expiry?: string
        spendLimit?: string
        calls?: string
        address?: `0x${string}`
        chainId?: string
        defaults?: boolean
      }) =>
        withJsonHandling(async () => {
          const result = await porto.grant({
            expiry: options.expiry,
            spendLimit: options.spendLimit ? Number(options.spendLimit) : undefined,
            calls: options.calls,
            defaults: options.defaults,
            address: options.address,
            chainId: options.chainId ? Number(options.chainId) : undefined,
          })
          saveConfig(config)
          emitOk(result)
        }),
    )

  portoCommand
    .command('send')
    .description('Send calls through Porto relay with prepared-call signing')
    .requiredOption('--calls <json>', 'Calls JSON payload')
    .option('--chain-id <id>', 'Chain ID')
    .option('--address <address>', 'Account address')
    .option('--permission-id <id>', 'Permission ID to enforce')
    .action(
      (options: {
        calls: string
        chainId?: string
        address?: `0x${string}`
        permissionId?: `0x${string}`
      }) =>
        withJsonHandling(async () => {
          const result = await porto.send({
            calls: options.calls,
            chainId: options.chainId ? Number(options.chainId) : undefined,
            address: options.address,
            permissionId: options.permissionId,
          })
          emitOk(result)
        }),
    )

  portoCommand
    .command('permissions')
    .description('List active permissions and expiry')
    .option('--address <address>', 'Account address override')
    .action((options: { address?: `0x${string}` }) =>
      withJsonHandling(async () => {
        const result = await porto.permissions({
          address: options.address,
        })
        emitOk(result)
      }),
    )

  await withJsonHandling(async () => {
    await program.parseAsync(argv)
  })
}
