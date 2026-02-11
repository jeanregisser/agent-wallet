import { AppError } from './errors.js'

function stableStringify(payload: unknown) {
  return JSON.stringify(payload, null, 2)
}

export function emitOk(payload: Record<string, unknown>) {
  process.stdout.write(stableStringify({ ok: true, ...payload }) + '\n')
}

export function emitError(error: AppError) {
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

  process.stderr.write(stableStringify(body) + '\n')
}
