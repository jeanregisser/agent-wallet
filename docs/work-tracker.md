# Work Tracker

## Snapshot (2026-02-20)
- Branch: `main`
- Active command surface: `configure`, `sign`, `status`
- Canonical spec: `/Users/jean/src/github.com/jeanregisser/agent-wallet/docs/cli-spec.md`
- Workflow policy: `/Users/jean/src/github.com/jeanregisser/agent-wallet/AGENTS.md`

Latest validation on this machine (2026-02-20):
- `npm run typecheck` -> pass
- `npm run build` -> pass
- `AGENT_WALLET_E2E_DEBUG=1 npm run test:e2e` -> pass (`4 passed / 0 failed`)
- `AGENT_WALLET_E2E_DEBUG=1 npx vitest run --project e2e test/e2e/sign.e2e.ts` -> pass
- `sign.e2e` live debug run:
  - allowlisted call succeeds via relay send and returns a real onchain `txHash` when receipt is available
  - non-allowlisted call fails deterministically with `PORTO_SEND_PREPARE_FAILED` and `UnauthorizedCall`

## Key Insights (Precall Model)
- Configure can be frictionless and still safe by using Porto precalls first (`wallet_grantPermissions`) and deferring activation to first real send.
- Relay key reads (`wallet_getKeys`) are reliable for active onchain permissions, but they do not represent all pending precall intent.
- Human UX needs explicit state, so configure now reports one of:
  - `active_onchain`
  - `pending_activation`
- Idempotency with precalls requires local pending-state memory to avoid re-queuing the same permission envelope on rerun.
- If intent changes before activation, queueing a newer precall is acceptable, but configure must state that activation is still pending.

## Now
- Stabilize and document activation-state transitions (`pending_activation` -> `active_onchain`) in a dedicated live e2e scenario.
- Keep configure/status human messaging explicit about `active_onchain` vs `pending_activation`.
- Decide whether to expose optional operator-facing debug toggles for runtime command traces (without changing normal output contract).

## Next
- Move Secure Enclave opaque handle storage from config into keychain item.
- Introduce account profile model with alias + default selection.
- Expand colocated unit coverage under `src/**`.
- Decide CI strategy for live passkey e2e (scheduled/manual vs per-PR).

## Later
- Remote-admin setup (out-of-band admin ceremony from separate device).
- Multi-account aliases and default profile ergonomics.
- Evaluate additional backend adapters after Porto-first UX stabilizes.

## Done
- Reworked `configure` into explicit linear phases and steps with `Now`/`You`/`Result`/`Next`.
- Made `configure` human-only (`--json` rejected with `CONFIGURE_HUMAN_ONLY`).
- Removed configure send/funding finalization dependency and switched to a Porto-precall-first reconciliation flow.
- Added persisted `pendingPermission` state in config for idempotent reruns and clear `pending_activation` reporting.
- Removed hidden configure self-call allowance injection and added explicit rejection of insecure broad self-call allowlist entries.
- Added explicit activation classification and human summary output (`Activation state`, pending details, and next action).
- Renamed configure checkpoint names to human-meaningful identifiers: `account`, `agent_key`, `permission_state`, `permission_preparation`, `permission_classification`, `outcome`.
- Removed ambiguous fallback behavior in configure permission preparation/finalization.
- Updated `configure.e2e` assertions to the new human flow markers and state model.
- Hardened Porto RPC/send diagnostics with explicit operation timeouts and stage-specific error codes (`RELAY_REQUEST_TIMEOUT`, `PORTO_SEND_*_TIMEOUT`).
- Switched `sign` transport to relay mode (headless, no dialog dependency) and removed explicit permission-id usage from sign send flow.
- Added research/debug scripts for investigation (not runtime/CI):
  - `/Users/jean/src/github.com/jeanregisser/agent-wallet/scripts/debug-selfcall-escalation.mjs`
  - `/Users/jean/src/github.com/jeanregisser/agent-wallet/scripts/debug-wallet-getkeys.mjs`
- Kept `sign` and `status` command surfaces unchanged while preserving security model constraints.
- Kept Porto internal-only as adapter/backend.
- Updated sign send/result semantics to reduce ambiguity between `txHash` (chain identifier) and `bundleId` (relay identifier).
