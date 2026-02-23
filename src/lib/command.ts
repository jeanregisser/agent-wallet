import { Command } from 'commander'
import { toAppError } from './errors.js'
import {
  emitFailure,
  emitSuccess,
  resolveOutputMode,
  type HumanRenderer,
  type OutputMode,
} from './output.js'

export async function runCommandAction(
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
