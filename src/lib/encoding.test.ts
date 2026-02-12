import { describe, expect, it } from 'vitest'

import { bytesToHex, hexToBytes, normalizeHex } from './encoding.js'
import { AppError } from './errors.js'

describe('encoding', () => {
  it('normalizes values without 0x prefix', () => {
    expect(normalizeHex('abcd')).toBe('0xabcd')
  })

  it('round-trips hex bytes', () => {
    const bytes = hexToBytes('0x1234abcd')
    expect(bytesToHex(bytes)).toBe('0x1234abcd')
  })

  it('throws AppError on invalid hex input', () => {
    expect(() => hexToBytes('0xzz')).toThrowError(AppError)
    expect(() => hexToBytes('0x123')).toThrowError(AppError)
  })
})
