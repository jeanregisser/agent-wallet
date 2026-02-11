import { AppError } from './errors.js'

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function requireInteractive(command: string, hint: string) {
  if (isInteractive()) return

  throw new AppError(
    'NON_INTERACTIVE_REQUIRES_FLAGS',
    'Command requires an interactive TTY. Re-run with explicit flags or --headless.',
    {
      command,
      hint,
    },
  )
}
