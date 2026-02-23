# CLI Spec (v0.2)

## Product Direction
`agent-wallet` is a security-first wallet CLI for autonomous agents.

Primary user promise:
- Give an agent a wallet that can act autonomously with tight, inspectable policy boundaries.
- Keep private key operations hardware-backed and non-exportable by default.
- Minimize footguns in non-interactive/automation contexts.

Porto is currently the execution backend, but not the user-facing mental model.

## Design Principles
- Security-first defaults: deny by default, grant least privilege.
- Non-exportable signing keys: private key material never returned to user-space.
- Policy-bound autonomy: expiry, spend constraints, and call allowlists.
- Operational clarity: predictable JSON outputs and actionable errors.
- Explicit interactivity: interactive steps fail clearly in headless environments.

## Scope & Constraints (MVP)
- Language/runtime: TypeScript on Node.js ESM.
- Signer backend: real macOS Secure Enclave now; backend interface for future platforms.
- Config path: platform-standard user config directory with `AGENT_WALLET_CONFIG_HOME` override.
- Backend today: Porto.
- Setup mode for MVP: local-admin only (same device runs configure and passkey ceremony).
- Security follow-up: move signer opaque handle from config into OS keychain storage.

## Security Model (Porto-Derived)
Core entities:
- Smart account onchain (policy enforcement point).
- Human admin key (passkey/WebAuthn) with full administrative authority.
- Agent key (P-256, Secure Enclave-backed, non-extractable) used for autonomous operations.

Trust and enforcement:
- Human admin authorizes agent key permissions on the smart account.
- Local passkey authorization requires user interaction (presence/verification), so the agent cannot silently self-authorize.
- Agent key can sign, but only within granted policy boundaries.
- Smart account enforces policy on every call (scope, spend, expiry, and key binding).
- Agent private key cannot be exported from Secure Enclave by design.

Primary residual risk:
- Prompt/tool misuse can cause unintended calls to be requested.
- Mitigation is least-privilege permissions, short expiries, and revocation/rotation.
- Local-admin note (MVP): if the admin passkey is used on the same host as the agent runtime, host compromise can still drive approval attempts.

```mermaid
flowchart LR
    H["Human Operator"] --> P["Passkey Admin Key"]
    P --> SA["Smart Account"]
    A["Agent Runtime"] --> SE["Secure Enclave Agent Key"]
    P -->|Authorize Session Permissions| SA
    SE -->|Sign Prepared Call Digest| A
    A -->|Submit Calls| R["Porto Relay"]
    R --> SA
    SA -->|Enforce Key, Scope, Spend, Expiry| C["Blockchain Execution"]
```

## Canonical UX (Target)
Three user-facing commands:

### 1. `agent-wallet configure`
Configures one account end-to-end:
- create or reuse account
- initialize/reuse local agent signing key
- grant permissions using Porto inline grant via `wallet_connect`
- report granted permission ID

Expected characteristics:
- idempotent when re-run (skips grant if an active permission already exists)
- interactive by default (opens Porto dialog for passkey/account selection)
- explicit human progress output with step context
- per-step operator guidance (`Now`, `You`, result, and next action on failure)

MVP policy:
- `configure` supports local-admin setup only.
- `configure` is add-only: to revoke permissions, use id.porto.sh.
- Remote-admin/out-of-band setup (admin ceremony on another device) is explicitly deferred.
- Permission policy (call allowlist, spend limits, expiry) is hardcoded to permissive defaults for now.
  See `docs/permissions-plan.md` for the planned user-configurable policy approach.

Default permission envelope (hardcoded):
- Calls: any target, any function selector
- Spend: $100/day
- Expiry: 7 days

Idempotency semantics:
- `configure` must never create duplicate signer keys or duplicate permission grants.
- Re-running `configure` checks for an existing active permission via `wallet_getKeys` before granting.
- If an active permission exists, the account step reports `already_ok` and skips the dialog.
- If no active permission exists, `configure` opens the dialog for sign-in + grant.

Checkpoint identifiers in output:
- `agent_key`
- `account`

Each step prints:
- step position
- what is happening now
- what the human must do (or that no action is required)
- success/failure for that step
- actionable next step if failed

Active permissions are resolved from Relay key state (`wallet_getKeys`).
Locally persisted `permissionIds` are a cache only.

### 2. `agent-wallet sign`
Agent execution/signing command.

For MVP this is call-bundle oriented:
- prepare calls
- sign digest using local hardware-backed key
- submit prepared calls
- return both relay bundle id and send status
- avoid ambiguity between relay and chain identifiers: `bundleId` is relay-only, `txHash` is onchain-only

Advanced/raw signing is out of scope for MVP.

### 3. `agent-wallet status`
Inspection command.

Should include:
- active account/profile
- backend/provider in use
- activation state (`active_onchain` or `unconfigured`)
- key backend health
- granted permissions summary + expiry
- balance snapshot per configured chain

MVP status behavior:
- `status` permission summary is derived from Relay key state and does not initiate a dialog connect.
- If no active agent permission is found on Relay, permissions summary reports zero and activation state is `unconfigured`.

## Account Model
- Multiple accounts are first-class in the data model.
- Selection key: `--account <address-or-alias>`.
- Alias support should be supported in config and surfaced in `status`.
- If no account is passed, use configured default account.

## Internal Architecture
- Keep provider details behind an adapter boundary.
- Current adapter: Porto.
- Keep “Powered by Porto” visible in docs/version/status output.
- Avoid premature multi-provider abstraction complexity until a second backend is real.

## Custody Stance
- Key custody is user-controlled and non-custodial.
- Provider infrastructure (currently Porto) is an execution dependency, not a key custodian.
- Project goal is low provider lock-in through adapter boundaries, without claiming infrastructure independence.

## Output Contract
Global output modes:
- `--json`: machine-readable output (stable schema).
- `--human`: operator-friendly output (tables/messages).

Command defaults (MVP):
- `configure`: human-only interactive flow (progress text is the contract).
- `sign`: json-first, with optional concise human summary.
- `status`: human-first by default, with full `--json` parity.

Implementation rules:
- Commands must use a single business-logic path and separate renderers.
- JSON mode writes only JSON to stdout.
- Human logs/progress/spinners must not be mixed into JSON stdout.
- Errors must preserve structured codes/details in JSON mode.
- `configure` is an exception: it is human-output only and should reject `--json`.

## Error Model
All command failures return:
```json
{ "ok": false, "error": { "code": "...", "message": "...", "details": {} } }
```

## Testing (E2E)
Strategy:
- Prefer a small number of scenario tests with broad coverage over many narrow tests.
- Each feature test should validate behavior plus the key invariants that prevent regression slope.
- Every top-level feature must have at least one robust e2e scenario.

Required scenario set (concise but high-signal):
1. `configure.e2e`
- Happy path: creates or reuses account and grants agent key permissions.
- Recovery invariant: rerun is idempotent and does not duplicate keys/grants.
- Output invariant: human flow markers appear in order (step/now/result), include actionable guidance.
2. `sign.e2e`
- Happy path: call succeeds with a valid bundle ID.
- Output invariant: JSON response schema is stable.
3. `status.e2e`
- Happy path: reports account, permissions summary, and balances.
- Output invariant: both `--json` and `--human` modes work.

Notes:
- E2E defaults to testnet (Base Sepolia + faucet funding) for automation reliability, with optional prod override for manual smoke checks.
- E2E files live under `test/e2e` and use the `*.e2e.ts` naming convention.
- E2E tests run as the dedicated `e2e` Vitest project.
- E2E scenarios run in live mode only.
- `configure` happy-path e2e must automate the full browser passkey ceremony.
- Browser passkey automation uses Playwright virtual authenticators (`WebAuthn.addVirtualAuthenticator`) so registration + assertion are exercised in tests.
- Current test defaults:
  - `AGENT_WALLET_E2E_NETWORK=testnet` (default when unset)
  - optional `AGENT_WALLET_E2E_NETWORK=prod` override
  - optional `AGENT_WALLET_E2E_DIALOG_HOST=<host>` override
  - optional `AGENT_WALLET_E2E_HEADLESS=0` to run browser visibly for manual debugging
  - optional `AGENT_WALLET_E2E_STRICT_DIALOG=0` to tolerate non-actionable follow-up dialog URLs (debug-only)

## Current Implementation Note
Current codebase now exposes the top-level command surface:
- `agent-wallet configure`
- `agent-wallet sign`
- `agent-wallet status`

Porto remains an internal adapter and is not exposed as a dedicated CLI command group.

## Next Iteration Checklist
- [x] Replace user-facing `porto` command group with `configure`, `sign`, `status`.
- [ ] Introduce account profile model with alias + default selection.
- [x] Keep Porto adapter internal and non-primary in CLI docs/help.
- [x] Implement global `--json` / `--human` output modes with per-command defaults.
- [ ] Move Secure Enclave opaque handle storage from config to keychain item.
- [x] Add E2E coverage for new top-level command surface.
- [ ] Add remote-admin setup mode (out-of-band admin ceremony from separate device).
- [ ] Evaluate additional backend adapters (e.g., ZeroDev, Privy, Para, others) using security/custody/lock-in criteria before adding support.
