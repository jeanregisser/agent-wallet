# Agent Wallet

Secure-by-default wallet CLI for autonomous agents.

Goal:
- Give an agent a real wallet with hardware-backed signing and least-privilege execution defaults.
- Keep backend/provider details secondary to the operator experience.

Current backend: Porto.

## Status
Work in progress.

Current code includes a functioning TypeScript scaffold with:
- macOS Secure Enclave signing backend
- Porto onboarding/permissions/send integration
- e2e test harness

We will likely refactor command surface aggressively (no migration constraints yet).

Security note:
- Current implementation stores Secure Enclave opaque handle in config.
- Follow-up: move this handle to OS keychain storage.

## Intended CLI Surface
Top-level commands (target):
1. `agent-wallet configure`
2. `agent-wallet sign`
3. `agent-wallet status`

Rationale:
- `configure`: one-shot account setup (create/reuse account + authorize local agent key + apply default policy envelope).
- `sign`: execute/sign actions within granted policy scope.
- `status`: inspect account, key backend, permissions, and balance.

Porto should remain visible as "powered by Porto", but not drive primary command naming.

## Multi-Account Direction
- Multiple accounts should be first-class.
- Account selection should use `--account <address-or-alias>`.
- Alias + default account support should be added in config model.

## Design Principles
- Security-first defaults
- Non-exportable private key material
- Policy-bound autonomy (expiry, spend limits, allowlists)
- Clear machine-readable outputs/errors
- Strong non-interactive ergonomics for agent environments

## Development
Install/build:
```bash
npm install
npm run typecheck
npm run build
```

Current WIP command surface:
```bash
node dist/agent-wallet.js signer init
node dist/agent-wallet.js signer pubkey
node dist/agent-wallet.js porto onboard --testnet
node dist/agent-wallet.js porto grant --defaults --calls '[{"to":"0xabc..."}]' --expiry 2026-12-31T00:00:00Z
node dist/agent-wallet.js porto send --calls '[{"to":"0xabc...","data":"0x","value":"0x0"}]'
node dist/agent-wallet.js porto permissions
```

Spec source of truth:
- `/Users/jean/src/github.com/jeanregisser/agent-wallet/docs/cli-spec.md`

## Near-Term Priorities
- Implement new `configure/sign/status` top-level UX.
- Keep Porto adapter internal.
- Move signer handle persistence into keychain.
- Add E2E coverage for the new top-level UX.
