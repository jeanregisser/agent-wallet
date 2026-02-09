# Agent Wallet (Porto-native MVP)

Porto-native agent wallet for OpenClaw. Passkey onboarding + Secure Enclave agent key means the private key never leaves hardware, while policy-scoped permissions enable safe, autonomous execution.

## Status
Draft MVP spec and repo scaffolding.

## MVP Goals
- One-time passkey onboarding via Porto
- Generate an agent key in Secure Enclave (non-extractable)
- Grant scoped permissions to that agent key (expiry, spend limits, allowlists)
- Autonomous signing with no user prompts during execution
- Minimal inspection tooling (address, permissions, expiry)

## Testing Strategy
E2E tests are required to validate core flows and protect against regressions, especially when LLM agents modify the code.

E2E coverage (minimum):
1. Onboarding flow (passkey + account creation)
2. Secure Enclave key creation and pubkey retrieval
3. Permission grant + list permissions
4. Successful call within limits
5. Rejected call outside limits

Test harness requirements:
- Deterministic test mode (testnet, small limits, fixed allowlists)
- CLI-driven tests (simulate how OpenClaw uses the tool)
- Clear pass/fail outputs for automation

## POC Success Checklist (Stop/Go)
POC Goal: prove a Porto-native, Secure Enclave, non-extractable agent key can sign autonomously within permission limits.

Success criteria (all must pass):
1. Onboarding works: passkey flow completes and returns a valid account address.
2. Secure Enclave key works: `agent-signer init` creates a non-extractable key; `agent-signer pubkey` returns a valid public key.
3. Permission grant works: Porto grants permissions to the agent key with expiry, caps, and allowlists.
4. Autonomous signing works: a call within limits succeeds without user prompts.
5. Limits enforce: a call outside caps/allowlists is rejected.

Stop/Go rule:
- If any item fails after 2-3 focused attempts, pause and reassess before building more.

## Architecture (v0)
Single primary CLI:
- `agent-wallet` (Porto adapter)
  - Handles Porto onboarding and permission grants
  - Sends calls through the Porto relay within policy boundaries
  - Uses an internal signer module backed by Secure Enclave

Shortcut CLI:
- `porto-wallet` (shim) forwards to `agent-wallet porto ...`

## Components
### 1. agent-signer (internal module for now)
Internal signer module used by `agent-wallet` to provide a tiny signing surface without exporting private material.

Commands:
- `agent-signer init`
- `agent-signer pubkey`
- `agent-signer sign <payload>`
- `agent-signer info`

Spec: `docs/cli-spec.md`

### 2. openclaw-skill
A thin OpenClaw skill that shells out to the CLI (no key material in-process).

Planned tools (shell to CLI):
- `agent_wallet_onboard`
- `agent_wallet_grant_permissions`
- `agent_wallet_send_calls`
- `agent_wallet_permissions`

## Design Principles
- Security-first: default deny until permissions are granted
- No exportable keys: private key material must never be readable or exportable
- Policy-bound autonomy: all actions constrained by spend caps, allowlists, and expiry
- Minimal surface area: small CLI surface, clear boundaries
- Observable by default: permissions and limits must be inspectable
- No prompts during autonomous signing (explicit choice, increased risk)

## Key Types (MVP)
- Primary backend: Secure Enclave P-256 (macOS)
- Future backends may add other curves (e.g., secp256k1) while keeping the same CLI surface

## Porto Integration (Current Reference)
Follow Porto’s published experiment flow for permissions + prepared calls:
- Client grants permissions via `experimental_grantPermissions`
- Server prepares calls via `wallet_prepareCalls` and signs the returned digest
- Server submits via `wallet_sendPreparedCalls` with the signature
This flow is documented in Porto’s EXP-0003 “Application Subscriptions” experiment and is the reference for our MVP.

Porto’s account contract also advertises access-control policies and session keys to enable policy-bound autonomy.

## Default Permission Envelope (MVP)
User configurable, but provide safe defaults:
- Require allowlist for `to` addresses
- Per-tx USD cap (small, e.g., $25)
- Daily USD cap (small, e.g., $100)
- Short expiry (e.g., 7 days)

## Compatibility (MVP)
Accept:
- External signer + on-chain permissions (Porto)

Evaluate later:
- Custodied permissions with strong policy enforcement

Reject for now:
- API-key-only signing without a hardware-backed signer

## Roadmap
- Add adapter layer for other backends (ZeroDev, Privy) without changing signer
- Support additional hardware backends (TPM, YubiKey)
- Optional local daemon mode for lower latency

## Repo Layout
See `docs/repo-layout.md`.

## Skill Distribution (ClawHub)
The OpenClaw skill is a folder under `skills/porto-wallet`. Publish that folder to ClawHub; no npm package is required for the skill itself.
