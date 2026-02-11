import { execa } from 'execa'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const runE2E = process.env.AGENT_WALLET_E2E === '1'

const maybeDescribe = runE2E ? describe : describe.skip

function parseJson(output: string) {
  return JSON.parse(output) as { ok: boolean; [key: string]: unknown }
}

async function runCli(args: string[], env: NodeJS.ProcessEnv) {
  const result = await execa('node', ['dist/agent-wallet.js', ...args], {
    reject: false,
    env,
  })

  const output = (result.stdout || result.stderr || '').trim()
  const payload = parseJson(output)

  return {
    ok: result.exitCode === 0 && payload.ok === true,
    payload,
    exitCode: result.exitCode,
  }
}

maybeDescribe('agent-wallet live e2e', () => {
  it('initializes signer and exports public key', async () => {
    const configHome = await mkdtemp(path.join(os.tmpdir(), 'agent-wallet-e2e-'))
    const env = {
      ...process.env,
      AGENT_WALLET_CONFIG_HOME: configHome,
    }

    const init = await runCli(['signer', 'init'], env)
    expect(init.ok).toBe(true)

    const pubkey = await runCli(['signer', 'pubkey', '--format', 'jwk'], env)
    expect(pubkey.ok).toBe(true)
    expect(pubkey.payload.publicKey).toBeTypeOf('object')
  })
})
