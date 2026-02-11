import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getConfigDirectory } from '../../lib/config.js'
import { bytesToHex, hexToBytes, normalizeHex } from '../../lib/encoding.js'
import { AppError } from '../../lib/errors.js'
import { runCommand } from '../../lib/exec.js'
import type { SignHashMode, SignerBackend } from '../types.js'
import { SECURE_ENCLAVE_SWIFT_SOURCE } from './swiftSource.js'

type SwiftResponse = {
  ok: boolean
  [key: string]: unknown
}

const SCRIPT_FILE_NAME = 'secure-enclave.swift'

function getScriptPath() {
  return path.join(getConfigDirectory(), 'bin', SCRIPT_FILE_NAME)
}

function ensureSwiftScript() {
  const scriptPath = getScriptPath()
  const targetDir = path.dirname(scriptPath)
  fs.mkdirSync(targetDir, { recursive: true })

  const sourceHash = crypto
    .createHash('sha256')
    .update(SECURE_ENCLAVE_SWIFT_SOURCE)
    .digest('hex')

  if (fs.existsSync(scriptPath)) {
    const existing = fs.readFileSync(scriptPath, 'utf8')
    const existingHash = crypto.createHash('sha256').update(existing).digest('hex')
    if (existingHash === sourceHash) return scriptPath
  }

  fs.writeFileSync(scriptPath, SECURE_ENCLAVE_SWIFT_SOURCE, { mode: 0o700 })
  return scriptPath
}

function parseSwiftJson(stdout: string): SwiftResponse {
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    throw new AppError('SIGNER_BACKEND_INVALID_RESPONSE', 'Secure Enclave helper returned no output.')
  }

  const lastLine = lines[lines.length - 1]!
  try {
    return JSON.parse(lastLine) as SwiftResponse
  } catch (error) {
    throw new AppError('SIGNER_BACKEND_INVALID_RESPONSE', 'Secure Enclave helper returned invalid JSON.', {
      output: lastLine,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

function assertOk(response: SwiftResponse) {
  if (response.ok) return

  const errorPayload = response.error as { code?: string; message?: string } | undefined
  throw new AppError(
    errorPayload?.code ?? 'SIGNER_BACKEND_ERROR',
    errorPayload?.message ?? 'Secure Enclave helper failed.',
    response,
  )
}

async function runSwift(args: string[]) {
  if (process.platform !== 'darwin') {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      'Secure Enclave backend is available only on macOS.',
      {
        platform: process.platform,
      },
    )
  }

  const scriptPath = ensureSwiftScript()
  const cacheRoot = path.join(path.dirname(scriptPath), 'swift-cache')
  fs.mkdirSync(cacheRoot, { recursive: true })

  const env = {
    ...process.env,
    SWIFT_MODULE_CACHE_PATH: process.env.SWIFT_MODULE_CACHE_PATH ?? cacheRoot,
    CLANG_MODULE_CACHE_PATH: process.env.CLANG_MODULE_CACHE_PATH ?? cacheRoot,
  }

  try {
    const { stdout } = await runCommand('swift', [scriptPath, ...args], env)
    const response = parseSwiftJson(stdout)
    assertOk(response)
    return response
  } catch (error) {
    if (error instanceof AppError && error.code === 'COMMAND_EXECUTION_FAILED') {
      const stdout = String(error.details?.stdout ?? '')
      if (stdout.trim()) {
        const response = parseSwiftJson(stdout)
        assertOk(response)
        return response
      }
    }

    throw error
  }
}

export class MacOsSecureEnclaveBackend implements SignerBackend {
  readonly name = 'secure-enclave'

  async create(_options: { label?: string }) {
    const response = await runSwift(['create'])

    const publicKey = normalizeHex(String(response.publicKey ?? '')) as `0x${string}`
    const handle = String(response.handle ?? '')

    if (!/^0x[0-9a-f]+$/i.test(publicKey)) {
      throw new AppError('SIGNER_BACKEND_INVALID_RESPONSE', 'Secure Enclave helper returned an invalid public key.')
    }

    if (!handle) {
      throw new AppError('SIGNER_BACKEND_INVALID_RESPONSE', 'Secure Enclave helper returned an empty key handle.')
    }

    return {
      publicKey,
      handle,
    }
  }

  async getPublicKey(handle: string) {
    const response = await runSwift(['pubkey', '--handle', handle])
    const publicKey = normalizeHex(String(response.publicKey ?? '')) as `0x${string}`

    if (!/^0x[0-9a-f]+$/i.test(publicKey)) {
      throw new AppError('SIGNER_BACKEND_INVALID_RESPONSE', 'Secure Enclave helper returned an invalid public key.')
    }

    return publicKey
  }

  async sign(handle: string, payload: Uint8Array, hash: SignHashMode) {
    const response = await runSwift([
      'sign',
      '--handle',
      handle,
      '--payload-hex',
      bytesToHex(payload),
      '--hash',
      hash,
    ])

    const signature = normalizeHex(String(response.signature ?? ''))
    return hexToBytes(signature)
  }

  async info(handle: string) {
    const response = await runSwift(['info', '--handle', handle])
    return {
      exists: Boolean(response.exists),
    }
  }
}
