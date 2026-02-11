import { runAgentWallet } from './cli.js'

const argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'porto-wallet', 'porto', ...process.argv.slice(2)]

void runAgentWallet(argv)
