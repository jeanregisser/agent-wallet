export type KeyCurve = 'p256'
export type SignHashMode = 'none' | 'sha256'

export type SignerKey = {
  keyId: string
  curve: KeyCurve
  backend: string
}

export type InitKeyOptions = {
  keyId: string
  label?: string
  overwrite?: boolean
  existingHandle?: string
}

export interface SignerBackend {
  readonly name: string
  create(options: Pick<InitKeyOptions, 'label'>): Promise<{ publicKey: `0x${string}`; handle: string }>
  getPublicKey(handle: string): Promise<`0x${string}`>
  sign(handle: string, payload: Uint8Array, hash: SignHashMode): Promise<Uint8Array>
  info(handle: string): Promise<{ exists: boolean }>
}
