export type ErrorDetails = Record<string, unknown> | undefined

export class AppError extends Error {
  readonly code: string
  readonly details: ErrorDetails
  readonly exitCode: number

  constructor(code: string, message: string, details?: ErrorDetails, exitCode = 1) {
    super(message)
    this.code = code
    this.details = details
    this.exitCode = exitCode
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error

  if (error instanceof Error) {
    return new AppError('UNEXPECTED_ERROR', error.message)
  }

  return new AppError('UNEXPECTED_ERROR', String(error))
}
