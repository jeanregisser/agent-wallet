import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type AgentWalletConfig = {
  version: 1
  signer: {
    keyId: string
    backend: 'secure-enclave'
    label?: string
    handle?: string
  }
  porto?: {
    address?: `0x${string}`
    chainId?: number
    dialogHost?: string
    testnet?: boolean
    permissionIds: `0x${string}`[]
  }
}

const DEFAULT_CONFIG: AgentWalletConfig = {
  version: 1,
  signer: {
    keyId: 'se.agent.wallet.default',
    backend: 'secure-enclave',
  },
  porto: {
    permissionIds: [],
  },
}

function getConfigRoot() {
  if (process.env.AGENT_WALLET_CONFIG_HOME) {
    return process.env.AGENT_WALLET_CONFIG_HOME
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support')
  }

  if (process.platform === 'win32') {
    return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  }

  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
}

export function getConfigDirectory() {
  return path.join(getConfigRoot(), 'agent-wallet')
}

export function getConfigPath() {
  return path.join(getConfigDirectory(), 'config.json')
}

export function loadConfig(): AgentWalletConfig {
  const configPath = getConfigPath()

  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULT_CONFIG)
  }

  const raw = fs.readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<AgentWalletConfig>
  const parsedPorto: Partial<NonNullable<AgentWalletConfig['porto']>> = parsed.porto ?? {}

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    signer: {
      ...DEFAULT_CONFIG.signer,
      ...parsed.signer,
    },
    porto: {
      permissionIds: parsedPorto.permissionIds ?? [],
      ...(parsedPorto.address ? { address: parsedPorto.address } : {}),
      ...(typeof parsedPorto.chainId === 'number' ? { chainId: parsedPorto.chainId } : {}),
      ...(parsedPorto.dialogHost ? { dialogHost: parsedPorto.dialogHost } : {}),
      ...(typeof parsedPorto.testnet === 'boolean' ? { testnet: parsedPorto.testnet } : {}),
    },
  }
}

export function saveConfig(config: AgentWalletConfig) {
  const configPath = getConfigPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}
