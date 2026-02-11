import { AppError } from './errors.js'

export function normalizeHex(value: string) {
  return value.startsWith('0x') ? value : `0x${value}`
}

export function hexToBytes(value: string) {
  const normalized = normalizeHex(value)
  if (!/^0x[0-9a-fA-F]*$/.test(normalized)) {
    throw new AppError('INVALID_HEX', 'Invalid hex input.')
  }

  if (normalized.length % 2 !== 0) {
    throw new AppError('INVALID_HEX', 'Hex input must have an even number of characters.')
  }

  return Buffer.from(normalized.slice(2), 'hex')
}

export function bytesToHex(value: Uint8Array) {
  return `0x${Buffer.from(value).toString('hex')}`
}

export function toBase64Url(bytes: Uint8Array) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function parseJsonFlag<T>(value: string, errorCode = 'INVALID_JSON'): T {
  try {
    return JSON.parse(value) as T
  } catch (error) {
    throw new AppError(errorCode, 'Invalid JSON payload.', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}
