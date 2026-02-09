# CLI Spec (v0)

## Design Principles
- Security-first: default deny until permissions are granted
- No exportable keys: private key material must never be readable or exportable
- Policy-bound autonomy: actions constrained by spend caps, allowlists, and expiry
- Minimal surface area: small CLI surface, clear boundaries
- Observable by default: permissions and limits must be inspectable
- No prompts during autonomous signing (explicit choice, increased risk)

## Scope & Constraints
- Non-extractable key storage (Secure Enclave on macOS)
- Minimal attack surface
- Backend-agnostic signer usable by Porto and future adapters
- Single primary CLI (`agent-wallet`) for user-facing flows
- No exportable keys: private key material must never be readable or exportable
- Extensible key types: P-256 now, others later (e.g., secp256k1)

Implementation note:
- The implementing agent should consult Porto’s source code to align with current APIs, data formats, and recommended practices before coding.

## Canonical Flow (MVP)
1. Main user runs onboarding and creates or reuses an existing Porto account.
2. `agent-wallet` creates or reuses a Secure Enclave agent key via the signer module.
3. Main user authorizes that agent key on the Porto account.
4. `agent-wallet` applies initial permissions (safe defaults plus user overrides).
5. Agent executes autonomously within those permission boundaries.

## Internal Module: agent-signer
`agent-signer` is an internal module used by `agent-wallet` for now. It may be exposed as a standalone CLI later if needed.

Reference command surface:

### `agent-signer init`
Create a new hardware-backed key and store its handle in the OS keychain.

Flags:
- `--label <string>`: Optional human-readable label
- `--overwrite`: Replace existing key if present

Output (JSON):
```json
{
  "ok": true,
  "keyId": "se.agent.wallet.default",
  "curve": "p256",
  "backend": "secure-enclave"
}
```

### `agent-signer pubkey`
Return the public key for registration with wallet backends.

Flags:
- `--format <raw|hex|jwk|spki>` (default: `jwk`)

Output (JSON):
```json
{
  "ok": true,
  "keyId": "se.agent.wallet.default",
  "curve": "p256",
  "publicKey": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." }
}
```

### `agent-signer sign <payload>`
Sign a payload. The private key never leaves the enclave.

Flags:
- `--format <hex|base64|raw>` (default: `hex`)
- `--hash <none|sha256>` (default: `sha256`)

Input:
- `payload` is bytes (hex/base64) or raw string depending on format.

Output (JSON):
```json
{
  "ok": true,
  "keyId": "se.agent.wallet.default",
  "alg": "ES256",
  "signature": "<hex>"
}
```

### `agent-signer info`
Show backend and key metadata.

Output (JSON):
```json
{
  "ok": true,
  "backend": "secure-enclave",
  "curve": "p256",
  "keyId": "se.agent.wallet.default"
}
```

## Error Model
All errors return:
```json
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

## Commands: agent-wallet (Porto adapter)

### `agent-wallet porto onboard`
Interactive passkey onboarding and account creation.

Flags:
- `--testnet`
- `--dialog <hostname>` (default: `id.porto.sh`)
- `--headless` (prints a URL/code for user to complete in browser, if supported)

Output (JSON):
```json
{
  "ok": true,
  "address": "0x...",
  "chainId": 8453
}
```

Notes:
- Onboarding UX should take direct inspiration from the official Porto CLI (`porto onboard`), including prompt flow and default behavior.
- Reuse Porto CLI conventions for flags when possible (`--testnet`, `--dialog`) to reduce user confusion.

### `agent-wallet porto grant`
Grant scoped permissions to the agent key.

Flags:
- `--expiry <iso8601>`
- `--spend-limit <usd>`
- `--calls <json>`
- `--defaults` (apply safe defaults: allowlist required, low caps, short expiry)

Output (JSON):
```json
{ "ok": true, "permissionId": "..." }
```

Notes:
- Use Porto’s `experimental_grantPermissions` as the source of truth for permission schema.

### `agent-wallet porto send`
Send calls through the Porto relay within granted permissions.

Flags:
- `--calls <json>`
- `--chain-id <id>`

Output (JSON):
```json
{ "ok": true, "txHash": "0x..." }
```

Notes:
- Follow Porto’s prepared-call flow: `wallet_prepareCalls` (digest) + signer + `wallet_sendPreparedCalls`.

### `agent-wallet porto permissions`
List active permissions and expiry.

Output (JSON):
```json
{ "ok": true, "permissions": [ ... ] }
```

## Shortcut CLI

### `porto-wallet`
Shim that forwards to `agent-wallet porto ...` for convenience.

## Testing (E2E)
E2E tests must exercise the CLI surface (not just internal modules).

Required flows:
1. `agent-signer init` + `agent-signer pubkey`
2. `agent-wallet porto onboard`
3. `agent-wallet porto grant` + `agent-wallet porto permissions`
4. `agent-wallet porto send` within limits (expected success)
5. `agent-wallet porto send` outside limits (expected rejection)

Notes:
- Run on testnet by default.
- Tests should emit machine-readable results (JSON).
- Fail fast on missing permissions or invalid key handle.

## Backends (Roadmap)
- macOS Secure Enclave (v0)
- Windows CNG / TPM
- Linux TPM2
- YubiKey (PKCS#11)
