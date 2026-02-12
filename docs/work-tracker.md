# Work Tracker

## Handoff Snapshot (2026-02-11)
- Branch: `main`
- State intent: top-level CLI surface is now `configure`, `sign`, `status`; Porto remains internal.

Current implemented command surface:
- `agent-wallet configure`
- `agent-wallet sign`
- `agent-wallet status`

Canonical docs:
- Spec (source of truth): `/Users/jean/src/github.com/jeanregisser/agent-wallet/docs/cli-spec.md`
- Project overview: `/Users/jean/src/github.com/jeanregisser/agent-wallet/README.md`
- Agent workflow policy: `/Users/jean/src/github.com/jeanregisser/agent-wallet/AGENTS.md`

Latest validation attempts on this machine:
- `npm run typecheck` -> pass
- `npm run build` -> pass
- `npm run test` -> pass (unit project)
- `npm run test:e2e` -> pass (4/4 scenario tests)

Validation note:
- Current e2e scenarios are deterministic contract checks for command surface/output/error invariants.
- Live testnet happy-path execution still needs dedicated runs with interactive passkey ceremony.

## Now
- Run scenario suite against live testnet and record happy-path + security invariants (`configure/sign/status/non-interactive`).
- Tighten `configure` permission-profile persistence for explicit envelope reconciliation across reruns without requiring `--calls`.

## Next
- Move Secure Enclave opaque handle storage from config into keychain item.
- Introduce account profile model with alias + default selection.
- Expand colocated unit coverage under `src/**` now that Vitest `unit` + `e2e` projects are split.

## Later
- Remote-admin bootstrap (out-of-band admin ceremony from separate device).
- Multi-account aliases and default profile ergonomics.
- Evaluate additional backend adapters (ZeroDev, Privy, Para, others) after Porto-first UX stabilizes.

## Done
- Established security-model documentation in spec and README.
- Replaced user-facing `porto` command group with `configure`, `sign`, `status`.
- Removed expert `agent-wallet signer ...` subcommands from user-facing CLI.
- Implemented global `--json` / `--human` output modes with per-command defaults.
- Added scenario-based e2e files: `configure.e2e`, `sign.e2e`, `status.e2e`, `non-interactive.e2e`.
- Upgraded test setup to Vitest `4.0.18` with explicit `unit` (colocated in `src`) and `e2e` (in `test`) projects.
- Removed `AGENT_WALLET_E2E` gating and standardized e2e filenames to `*.e2e.ts`.
