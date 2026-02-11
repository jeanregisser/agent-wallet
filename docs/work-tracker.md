# Work Tracker

## Handoff Snapshot (2026-02-11)
- Branch: `main`
- State intent: docs now reflect target product direction; code still uses transitional `signer` + `porto` subcommands.

Current implemented command surface (WIP):
- `agent-wallet signer init|pubkey|sign|info`
- `agent-wallet porto onboard|grant|send|permissions`
- `porto-wallet` shim forwarding to `agent-wallet porto ...`

Target command surface (next implementation phase):
- `agent-wallet configure`
- `agent-wallet sign`
- `agent-wallet status`

Canonical docs:
- Spec (source of truth): `/Users/jean/src/github.com/jeanregisser/agent-wallet/docs/cli-spec.md`
- Project overview: `/Users/jean/src/github.com/jeanregisser/agent-wallet/README.md`
- Agent workflow policy: `/Users/jean/src/github.com/jeanregisser/agent-wallet/AGENTS.md`

Latest validation attempts on this machine:
- `npm run typecheck` -> terminated by runtime (`Signal 9`)
- `npm run build` -> terminated by runtime (`Signal 9`)
- `npm run test` -> terminated by runtime (`Signal 9`)

Validation note:
- Failures above appear environment/runtime-resource related, not assertion failures.
- Next agent should rerun validation in a less constrained runtime before trusting green status.

## Now
- Define and implement `configure`, `sign`, `status` top-level UX.
- Implement scenario-based e2e suite: `configure.e2e`, `sign.e2e`, `status.e2e`, `non-interactive.e2e`.

## Next
- Move Secure Enclave opaque handle storage from config into keychain item.
- Run the scenario-based e2e suite on testnet and record stable pass/fail contract.

## Later
- Remote-admin bootstrap (out-of-band admin ceremony from separate device).
- Multi-account aliases and default profile ergonomics.
- Evaluate additional backend adapters (ZeroDev, Privy, Para, others) after Porto-first UX stabilizes.

## Done
- Established security-model documentation in spec and README.
