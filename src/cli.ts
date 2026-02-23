import { Command } from 'commander'
import { loadConfig } from './lib/config.js'
import { AppError, toAppError } from './lib/errors.js'
import { emitFailure, inferOutputModeFromArgv, type OutputMode } from './lib/output.js'
import { closeWalletSession, PortoService } from './porto/service.js'
import { SignerService } from './signer/service.js'
import { registerConfigureCommand } from './commands/configure.js'
import { registerSignCommand } from './commands/sign.js'
import { registerStatusCommand } from './commands/status.js'

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

  registerConfigureCommand(program, { config, porto, signer })
  registerSignCommand(program, { porto })
  registerStatusCommand(program, { config, porto, signer })

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
