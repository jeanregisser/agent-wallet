# Permissions Configuration Plan

## Current State

`configure` grants a hardcoded default permission:

- **Calls**: any target, any function selector (wildcard)
- **Spend**: $100/day (in stablecoin units)
- **Per-tx fee limit**: $25
- **Expiry**: 7 days from grant time
- **Fee token**: EXP on testnet, native on mainnet

These defaults are intentionally permissive for early adoption.
Spend limits and expiry are the primary risk boundaries for now.

## Planned: User-Configurable Permission Policy

The goal is to let users express the full Porto permission spec through `configure`,
either interactively (TTY) or via flags (CI/scripts).

### Porto Permission Spec

```
calls:   [{ to?: address, signature?: string }]  – allowlisted targets/functions
spend:   [{ limit: bigint, period: string, token?: address }]  – spend caps
expiry:  unix timestamp
feeToken: { limit: string, symbol: string } | null
key:     auto-filled from Secure Enclave signer
```

### Option A: Interactive prompts (preferred for human UX)

Run `configure` with no flags; terminal prompts guide through each field:

```
─── Allowed calls ──────────────────────────────────────────────
  Contract address (0x... or * for any): 0xdead...
  Restrict to a specific function? (leave blank for any): transfer(address,uint256)
  Add another allowed call? [y/N]:

─── Spend limit ─────────────────────────────────────────────────
  Daily limit in USD [100]:
  Per-transaction limit in USD [25]:

─── Expiry ──────────────────────────────────────────────────────
  Valid for how long? [7d]:

─── Summary ─────────────────────────────────────────────────────
  Allowed calls:
    • 0xdead… — transfer(address,uint256) only
  Daily limit:   $100 USD
  Per-tx limit:  $25 USD
  Expires:       2026-03-01 (7 days)

  Grant these permissions? [Y/n]:
```

Implementation: Node built-in `readline/promises` — no extra dependency needed.

### Option B: Flags for automation / CI

Keep `--calls <json>` as an escape hatch for non-interactive use:

```
agent-wallet configure \
  --calls '[{"to":"0xdead...","signature":"transfer(address,uint256)"}]' \
  --spend-limit 25 \
  --expiry 7d
```

### Revocation

`configure` is add-only. To revoke permissions, users should visit:
`https://id.porto.sh` → manage permissions UI.

`status` should surface the management URL when permissions are active.

## Implementation Notes

- Prompt library: `readline/promises` (Node built-in, no dep)
- Non-interactive fallback: `--calls` flag skips prompts; error if neither TTY nor flag
- Idempotency: before granting, check relay for existing active permission matching the requested policy
- Security check: reject `to: <own-account>` without a specific selector (broad self-call)
