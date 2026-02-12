import { AppError } from './errors.js'

export type OutputMode = 'json' | 'human'

export type HumanRenderOptions = {
  payload: Record<string, unknown>
}

export type HumanRenderer = (options: HumanRenderOptions) => string

function stableStringify(payload: unknown) {
  return JSON.stringify(
    payload,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  )
}

export function resolveOutputMode(options: { json?: boolean; human?: boolean }, fallback: OutputMode): OutputMode {
  if (options.json && options.human) {
    throw new AppError('CONFLICTING_OUTPUT_FLAGS', 'Use only one output mode: --json or --human.')
  }

  if (options.json) return 'json'
  if (options.human) return 'human'

  return fallback
}

export function inferOutputModeFromArgv(argv: string[], fallback: OutputMode): OutputMode {
  const hasJson = argv.includes('--json')
  const hasHuman = argv.includes('--human')

  if (hasJson && hasHuman) {
    throw new AppError('CONFLICTING_OUTPUT_FLAGS', 'Use only one output mode: --json or --human.')
  }

  if (hasJson) return 'json'
  if (hasHuman) return 'human'

  return fallback
}

export function emitSuccess(mode: OutputMode, payload: Record<string, unknown>, humanRenderer?: HumanRenderer) {
  if (mode === 'json') {
    process.stdout.write(stableStringify({ ok: true, ...payload }) + '\n')
    return
  }

  const rendered = humanRenderer ? humanRenderer({ payload }) : stableStringify(payload)
  process.stdout.write(rendered + '\n')
}

export function emitFailure(mode: OutputMode, error: AppError) {
  if (mode === 'json') {
    const body: Record<string, unknown> = {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
    }

    if (error.details && Object.keys(error.details).length > 0) {
      ;(body.error as Record<string, unknown>).details = error.details
    }

    process.stdout.write(stableStringify(body) + '\n')
    return
  }

  const lines = [`${error.code}: ${error.message}`]
  if (error.details && Object.keys(error.details).length > 0) {
    lines.push(stableStringify(error.details))
  }

  process.stderr.write(lines.join('\n') + '\n')
}
