---
name: Porto Wallet
description: Porto-native agent wallet. Passkey onboarding plus a Secure Enclave agent key for non-extractable signing. This skill shells out to a local CLI.
---

# Porto Wallet (OpenClaw Skill)

This skill is a thin wrapper around the local CLI. It never handles private keys directly.

## Requirements
- Install the CLI locally (see repo README).
- macOS Secure Enclave for non-extractable key storage.

## Tools

### `agent_wallet_onboard`
Onboard a Porto account and prepare permissions setup.

### `agent_wallet_grant_permissions`
Grant scoped permissions (expiry, spend limits, allowlists) to the agent key.

### `agent_wallet_send_calls`
Send calls through Porto relay within the granted permissions.

### `agent_wallet_permissions`
List active permissions and expiry.

## Safety Rules
- Default deny: do not perform actions without explicit permissions
- Never attempt to export any key material (no exportable keys)
- If permissions are missing or expired, request re-authorization
