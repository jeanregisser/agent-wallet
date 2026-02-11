import { bytesToHex, hexToBytes, normalizeHex, toBase64Url } from '../lib/encoding.js'
import { AppError } from '../lib/errors.js'
import type { AgentWalletConfig } from '../lib/config.js'
import { MacOsSecureEnclaveBackend } from './macos/secureEnclaveBackend.js'
import type { InitKeyOptions, SignHashMode, SignerBackend } from './types.js'

export type PublicKeyFormat = 'raw' | 'hex' | 'jwk' | 'spki'
export type PayloadFormat = 'hex' | 'base64' | 'raw'

const P256_SPKI_PREFIX =
  '3059301306072a8648ce3d020106082a8648ce3d030107034200'

function getBackend(config: AgentWalletConfig): SignerBackend {
  if (config.signer.backend === 'secure-enclave') {
    return new MacOsSecureEnclaveBackend()
  }

  throw new AppError('UNSUPPORTED_BACKEND', `Unsupported signer backend: ${config.signer.backend}`)
}

function decodePayload(payload: string, format: PayloadFormat): Uint8Array {
  if (format === 'raw') return Buffer.from(payload, 'utf8')
  if (format === 'base64') return Buffer.from(payload, 'base64')
  return hexToBytes(payload)
}

function ensureUncompressedPublicKey(publicKey: `0x${string}`) {
  const bytes = hexToBytes(publicKey)
  if (bytes.length === 64) {
    return Buffer.concat([Buffer.from([0x04]), bytes])
  }

  if (bytes.length === 65 && bytes[0] === 0x04) return bytes

  throw new AppError('INVALID_PUBLIC_KEY', 'Expected an uncompressed P-256 public key.', {
    bytes: bytes.length,
  })
}

function formatPublicKey(publicKey: `0x${string}`, format: PublicKeyFormat) {
  const uncompressed = ensureUncompressedPublicKey(publicKey)

  if (format === 'raw') {
    return uncompressed.toString('base64')
  }

  if (format === 'hex') {
    return bytesToHex(uncompressed)
  }

  if (format === 'spki') {
    const spki = Buffer.from(P256_SPKI_PREFIX, 'hex')
    return bytesToHex(Buffer.concat([spki, uncompressed]))
  }

  const x = uncompressed.subarray(1, 33)
  const y = uncompressed.subarray(33, 65)
  return {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64Url(x),
    y: toBase64Url(y),
  }
}

function toPortoPublicKey(publicKey: `0x${string}`): `0x${string}` {
  const bytes = ensureUncompressedPublicKey(publicKey)
  return bytesToHex(bytes.subarray(1)) as `0x${string}`
}

export class SignerService {
  readonly #backend: SignerBackend

  constructor(private readonly config: AgentWalletConfig) {
    this.#backend = getBackend(config)
  }

  get keyId() {
    return this.config.signer.keyId
  }

  async init(options: Omit<InitKeyOptions, 'keyId'> = {}) {
    const existingHandle = this.config.signer.handle
    if (existingHandle && !options.overwrite) {
      const info = await this.#backend.info(existingHandle)
      if (info.exists) {
        return {
          keyId: this.config.signer.keyId,
          backend: this.#backend.name,
          curve: 'p256',
          created: false,
        }
      }
    }

    const result = await this.#backend.create({
      label: options.label,
    })
    this.config.signer.handle = result.handle

    return {
      keyId: this.config.signer.keyId,
      backend: this.#backend.name,
      curve: 'p256',
      created: true,
    }
  }

  async info() {
    const handle = this.config.signer.handle
    if (!handle) {
      return {
        keyId: this.config.signer.keyId,
        backend: this.#backend.name,
        curve: 'p256',
        exists: false,
      }
    }

    const result = await this.#backend.info(handle)
    return {
      keyId: this.config.signer.keyId,
      backend: this.#backend.name,
      curve: 'p256',
      exists: result.exists,
    }
  }

  async pubkey(format: PublicKeyFormat) {
    const handle = this.config.signer.handle
    if (!handle) {
      throw new AppError('KEY_NOT_INITIALIZED', 'Signer key has not been initialized. Run `agent-wallet signer init` first.')
    }

    const publicKey = await this.#backend.getPublicKey(handle)
    return {
      keyId: this.config.signer.keyId,
      curve: 'p256',
      publicKey: formatPublicKey(publicKey, format),
    }
  }

  async sign(payload: string, format: PayloadFormat, hash: SignHashMode) {
    const handle = this.config.signer.handle
    if (!handle) {
      throw new AppError('KEY_NOT_INITIALIZED', 'Signer key has not been initialized. Run `agent-wallet signer init` first.')
    }

    const bytes = decodePayload(payload, format)
    const signature = await this.#backend.sign(handle, bytes, hash)

    return {
      keyId: this.config.signer.keyId,
      alg: 'ES256',
      signature: bytesToHex(signature),
    }
  }

  async getPortoKey() {
    const handle = this.config.signer.handle
    if (!handle) {
      throw new AppError('KEY_NOT_INITIALIZED', 'Signer key has not been initialized. Run `agent-wallet signer init` first.')
    }

    const publicKey = await this.#backend.getPublicKey(handle)
    return {
      prehash: false,
      publicKey: toPortoPublicKey(normalizeHex(publicKey) as `0x${string}`),
      type: 'p256' as const,
    }
  }
}
