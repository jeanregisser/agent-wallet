import { execa } from 'execa'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function makeIsolatedEnv() {
  const configHome = await mkdtemp(path.join(os.tmpdir(), 'agent-wallet-e2e-'))

  return {
    ...process.env,
    AGENT_WALLET_CONFIG_HOME: configHome,
  }
}

export async function runCli(args: string[], env: NodeJS.ProcessEnv) {
  const result = await execa('node', ['dist/agent-wallet.js', ...args], {
    env,
    reject: false,
  })

  const output = (result.stdout || result.stderr || '').trim()
  let payload: Record<string, unknown> | null = null

  if (output) {
    try {
      payload = JSON.parse(output) as Record<string, unknown>
    } catch {
      payload = null
    }
  }

  return {
    exitCode: result.exitCode,
    payload,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}
