import { describe, expect, it } from 'vitest'

import {
  getLiveSession,
  readAgentWalletConfig,
  runConfigureRerun,
} from './helpers.js'

const LIVE_TIMEOUT_MS = 4 * 60 * 1_000

function expectInOrder(output: string, fragments: string[]) {
  let cursor = -1
  for (const fragment of fragments) {
    const index = output.indexOf(fragment, cursor + 1)
    expect(index, `Expected output fragment in order: ${fragment}`).toBeGreaterThan(cursor)
    cursor = index
  }
}

describe('configure.e2e', () => {
  it(
    'configures with real passkey ceremony and reruns idempotently',
    async () => {
      const session = await getLiveSession()

      expect(session.accountAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
      expect(session.chainId).toBeGreaterThan(0)

      const rerun = await runConfigureRerun(session)

      expect(rerun.exitCode).toBe(0)
      expectInOrder(rerun.stdout, [
        'Configure wallet (local-admin setup)',
        'Powered by Porto',
        '[Phase 1/3] Account & Key',
        '[Step 1/6] Account selection',
        'Now: Connect an existing account or create a new smart account.',
        '[Step 2/6] Agent key readiness',
        'Now: Ensure the local Secure Enclave agent key exists and is usable.',
        '[Phase 2/3] Permissions',
        '[Step 3/6] Permission state discovery',
        '[Step 4/6] Permission preparation',
        '[Step 5/6] Permission state classification',
        '[Phase 3/3] Outcome',
        '[Step 6/6] Operator state',
        'Configure complete',
        'Activation state:',
      ])

      const resultLines = rerun.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('Result: '))
      expect(resultLines.length).toBe(6)
      expect(resultLines.some((line) => line.includes('FAILED'))).toBe(false)

      const checkpointLines = rerun.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- '))

      const byCheckpoint = new Map<string, string>()
      for (const line of checkpointLines) {
        const match = /^-\s+([a-z_]+):\s+([a-z_]+)$/i.exec(line)
        if (!match) continue
        const checkpoint = match[1]
        const status = match[2]
        if (!checkpoint || !status) continue
        byCheckpoint.set(checkpoint, status)
      }

      expect(byCheckpoint.get('account')).toBe('already_ok')
      expect(byCheckpoint.get('agent_key')).toBe('already_ok')
      expect(['already_ok', 'updated']).toContain(byCheckpoint.get('permission_state'))
      expect(['already_ok', 'updated']).toContain(byCheckpoint.get('permission_preparation'))
      expect(['already_ok', 'updated']).toContain(byCheckpoint.get('permission_classification'))
      expect(['already_ok', 'updated']).toContain(byCheckpoint.get('outcome'))

      const config = await readAgentWalletConfig(session.configHome)
      expect(config.porto?.address?.toLowerCase()).toBe(session.accountAddress.toLowerCase())

      const permissionIds = config.porto?.permissionIds ?? []
      const uniquePermissionIds = new Set(permissionIds)
      expect(uniquePermissionIds.size).toBe(permissionIds.length)
    },
    LIVE_TIMEOUT_MS,
  )
})
