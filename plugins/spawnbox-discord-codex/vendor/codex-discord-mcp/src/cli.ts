#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { accessSync, constants, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import spawn from 'cross-spawn'
import { codexOptionsFromEnv } from './codex.js'
import {
  approvePendingCode,
  defaultAccess,
  ensureStateDir,
  getStatePaths,
  loadAccess,
  loadStateEnv,
  saveAccess,
  writeToken,
} from './state.js'
import { runMcpServer } from './mcp.js'
import { runRelay } from './relay.js'
import type { DmPolicy } from './types.js'

const DISCORD_BOT_PERMISSIONS = '274878008384'

async function main(): Promise<void> {
  const [command = 'mcp', ...args] = process.argv.slice(2)

  switch (command) {
    case 'mcp':
      await runMcpServer()
      return
    case 'bot':
      await runRelay()
      return
    case 'init':
      await initCommand()
      return
    case 'configure':
      await configure(args)
      return
    case 'access':
      await accessCommand(args)
      return
    case 'invite-url':
      inviteUrlCommand(args)
      return
    case 'print-config':
      printConfig(args)
      return
    case 'doctor':
      doctor(args)
      return
    case '-h':
    case '--help':
    case 'help':
      printHelp()
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

async function initCommand(): Promise<void> {
  const paths = getStatePaths()
  ensureStateDir(paths)
  loadStateEnv(paths)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    process.stdout.write(`codex-discord-mcp init\nstate directory: ${paths.stateDir}\n\n`)
    const tokenPrompt = process.env.DISCORD_BOT_TOKEN
      ? 'Discord bot token (leave blank to keep the current token): '
      : 'Discord bot token: '
    const token = (await rl.question(tokenPrompt)).trim()
    if (token) {
      writeToken(token, paths)
      process.stdout.write(`Wrote token to ${paths.envFile}\n`)
    } else if (!process.env.DISCORD_BOT_TOKEN) {
      process.stdout.write('No token saved. Run configure before starting bot or mcp mode.\n')
    }

    const clientId = (await rl.question('Discord application/client ID (optional): ')).trim()
    if (clientId) {
      process.stdout.write(`\nInvite URL:\n${buildInviteUrl(clientId)}\n`)
    }

    process.stdout.write(
      '\nNext commands:\n  codex-discord-mcp doctor\n  codex-discord-mcp bot\n',
    )
  } finally {
    rl.close()
  }
}

async function configure(args: string[]): Promise<void> {
  const paths = getStatePaths()
  const token = await tokenFromConfigureArgs(args)
  writeToken(token, paths)
  process.stdout.write(`Wrote token to ${paths.envFile}\n`)
}

async function tokenFromConfigureArgs(args: string[]): Promise<string> {
  const tokenEnvIndex = args.indexOf('--token-env')
  if (tokenEnvIndex >= 0) {
    const envName = args[tokenEnvIndex + 1]
    if (!envName) {
      throw new Error('Usage: codex-discord-mcp configure --token-env <env-var-name>')
    }
    const token = process.env[envName]
    if (!token) throw new Error(`${envName} is not set`)
    return token
  }

  const token = args[0]
  if (token) return token

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const pasted = (await rl.question('Discord bot token: ')).trim()
    if (!pasted) throw new Error('No token provided')
    return pasted
  } finally {
    rl.close()
  }
}

async function accessCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args
  const paths = getStatePaths()
  const access = loadAccess(paths)

  switch (subcommand) {
    case 'show':
    case undefined:
      process.stdout.write(`${JSON.stringify(access, null, 2)}\n`)
      return
    case 'reset':
      await saveAccess(defaultAccess(), paths)
      process.stdout.write(`Reset access policy in ${paths.accessFile}\n`)
      return
    case 'pair': {
      const code = rest[0]
      if (!code) throw new Error('Usage: codex-discord-mcp access pair <code>')
      const approved = await approvePendingCode(code, paths)
      process.stdout.write(
        `Approved ${approved.username ?? approved.senderId} (${approved.senderId})\n`,
      )
      return
    }
    case 'policy': {
      const policy = rest[0] as DmPolicy | undefined
      if (policy !== 'pairing' && policy !== 'allowlist' && policy !== 'disabled') {
        throw new Error('Usage: codex-discord-mcp access policy <pairing|allowlist|disabled>')
      }
      access.dmPolicy = policy
      await saveAccess(access, paths)
      process.stdout.write(`DM policy set to ${policy}\n`)
      return
    }
    case 'allow-user': {
      const userId = rest[0]
      if (!userId) throw new Error('Usage: codex-discord-mcp access allow-user <discord-user-id>')
      if (!access.allowUsers.includes(userId)) access.allowUsers.push(userId)
      await saveAccess(access, paths)
      process.stdout.write(`Allowed user ${userId}\n`)
      return
    }
    case 'remove-user': {
      const userId = rest[0]
      if (!userId) throw new Error('Usage: codex-discord-mcp access remove-user <discord-user-id>')
      access.allowUsers = access.allowUsers.filter(id => id !== userId)
      await saveAccess(access, paths)
      process.stdout.write(`Removed user ${userId}\n`)
      return
    }
    case 'allow-channel': {
      const channelId = rest[0]
      if (!channelId) {
        throw new Error(
          'Usage: codex-discord-mcp access allow-channel <channel-id> [--no-mention] [--allow-user <user-id>...]',
        )
      }
      const allowUsers = valuesAfter(rest, '--allow-user')
      access.channels[channelId] = {
        requireMention: !rest.includes('--no-mention'),
        allowUsers,
      }
      await saveAccess(access, paths)
      process.stdout.write(`Allowed channel ${channelId}\n`)
      return
    }
    case 'remove-channel': {
      const channelId = rest[0]
      if (!channelId) {
        throw new Error('Usage: codex-discord-mcp access remove-channel <channel-id>')
      }
      delete access.channels[channelId]
      await saveAccess(access, paths)
      process.stdout.write(`Removed channel ${channelId}\n`)
      return
    }
    case 'ack': {
      const value = rest[0]
      if (!value) throw new Error('Usage: codex-discord-mcp access ack <emoji|off>')
      access.ackReaction = value === 'off' ? undefined : value
      await saveAccess(access, paths)
      process.stdout.write(value === 'off' ? 'Ack reaction disabled\n' : `Ack reaction set to ${value}\n`)
      return
    }
    case 'mention-pattern': {
      await mentionPatternCommand(rest)
      return
    }
    case 'help':
    case '-h':
    case '--help':
      printAccessHelp()
      return
    default:
      throw new Error(`Unknown access command: ${subcommand}`)
  }
}

async function mentionPatternCommand(args: string[]): Promise<void> {
  const [action, pattern] = args
  const paths = getStatePaths()
  const access = loadAccess(paths)
  access.mentionPatterns ??= []

  if (action === 'list' || action == null) {
    process.stdout.write(`${JSON.stringify(access.mentionPatterns, null, 2)}\n`)
    return
  }

  if (action === 'add') {
    if (!pattern) throw new Error('Usage: codex-discord-mcp access mention-pattern add <regex>')
    if (!access.mentionPatterns.includes(pattern)) access.mentionPatterns.push(pattern)
    await saveAccess(access, paths)
    process.stdout.write(`Added mention pattern ${pattern}\n`)
    return
  }

  if (action === 'remove') {
    if (!pattern) throw new Error('Usage: codex-discord-mcp access mention-pattern remove <regex>')
    access.mentionPatterns = access.mentionPatterns.filter(item => item !== pattern)
    await saveAccess(access, paths)
    process.stdout.write(`Removed mention pattern ${pattern}\n`)
    return
  }

  throw new Error('Usage: codex-discord-mcp access mention-pattern <list|add|remove>')
}

function inviteUrlCommand(args: string[]): void {
  const clientId = args[0]
  if (!clientId) throw new Error('Usage: codex-discord-mcp invite-url <discord-client-id>')
  process.stdout.write(`${buildInviteUrl(clientId)}\n`)
}

function printConfig(args: string[]): void {
  process.stdout.write(buildConfigSnippet({ useNpx: args.includes('--npx') }))
}

export function buildConfigSnippet(options: { useNpx?: boolean; cliPath?: string } = {}): string {
  const useNpx = options.useNpx ?? false
  const cliPath = options.cliPath ?? fileURLToPath(import.meta.url)
  const command = useNpx ? 'npx' : 'node'
  const commandArgs = useNpx
    ? ['-y', 'codex-discord-mcp', 'mcp']
    : [cliPath, 'mcp']

  return `# Add this to ~/.codex/config.toml or .codex/config.toml:

[mcp_servers.discord]
command = ${tomlString(command)}
args = [${commandArgs.map(tomlString).join(', ')}]
startup_timeout_sec = 20
tool_timeout_sec = 60

# Token can live in ${getStatePaths().envFile}, or you can forward env instead:
# env_vars = ["DISCORD_BOT_TOKEN"]
\n`
}

function doctor(args: string[]): void {
  const report = collectDoctorReport()
  process.stdout.write(formatDoctorReport(report, args.includes('--json')))
}

export type DoctorCheck = {
  ok: boolean
  value?: string
  path?: string
  message?: string
}

export type DoctorReport = {
  ok: boolean
  checks: Record<string, DoctorCheck>
}

export function collectDoctorReport(): DoctorReport {
  const paths = getStatePaths()
  loadStateEnv(paths)
  const codexOptions = codexOptionsFromEnv()
  const checks: Record<string, DoctorCheck> = {
    node: checkNodeVersion(),
    codex: checkCodexCommand(codexOptions.command),
    stateDir: {
      ok: exists(paths.stateDir),
      path: paths.stateDir,
      message: exists(paths.stateDir) ? 'present' : 'missing',
    },
    envFile: {
      ok: exists(paths.envFile),
      path: paths.envFile,
      message: exists(paths.envFile) ? 'present' : 'missing',
    },
    discordToken: {
      ok: Boolean(process.env.DISCORD_BOT_TOKEN),
      value: process.env.DISCORD_BOT_TOKEN ? 'set' : 'missing',
    },
    accessFile: {
      ok: exists(paths.accessFile),
      path: paths.accessFile,
      message: exists(paths.accessFile) ? 'present' : 'missing',
    },
    workdir: {
      ok: exists(codexOptions.workdir),
      path: codexOptions.workdir,
      message: exists(codexOptions.workdir) ? 'present' : 'missing',
    },
    sandbox: {
      ok: true,
      value: codexOptions.sandbox,
    },
    approvalPolicy: {
      ok: true,
      value: codexOptions.approvalPolicy,
    },
    relayAttachments: {
      ok: true,
      value: codexOptions.relayAttachments ? 'on' : 'off',
    },
    outbox: {
      ok: true,
      path: codexOptions.outboxDir,
    },
  }

  return {
    ok: checks.node.ok && checks.codex.ok && checks.discordToken.ok && checks.workdir.ok,
    checks,
  }
}

export function formatDoctorReport(report: DoctorReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`

  return Object.entries(report.checks)
    .map(([key, check]) => {
      const status = check.ok ? 'ok' : 'warn'
      const value = check.value ?? check.path ?? check.message ?? ''
      const suffix = check.message && check.message !== value ? ` (${check.message})` : ''
      return `${key}: ${status}${value ? ` ${value}` : ''}${suffix}`
    })
    .join('\n')
    .concat('\n')
}

export function buildInviteUrl(clientId: string): string {
  if (!/^\d{5,25}$/.test(clientId)) {
    throw new Error('Discord client ID must be a numeric snowflake')
  }

  const params = new URLSearchParams({
    client_id: clientId,
    permissions: DISCORD_BOT_PERMISSIONS,
    scope: 'bot applications.commands',
  })
  return `https://discord.com/oauth2/authorize?${params.toString()}`
}

function printHelp(): void {
  process.stdout.write(`codex-discord-mcp

Commands:
  mcp                     Run the Discord MCP server over stdio
  bot                     Run Discord -> codex exec relay mode
  init                    Interactive first-run setup
  configure [token]       Store DISCORD_BOT_TOKEN in the state .env file
  access <command>        Manage local allowlist and pairing
  invite-url <client-id>  Print a Discord bot invite URL
  print-config [--npx]    Print a Codex config.toml MCP snippet
  doctor [--json]         Show basic local configuration status

Run "codex-discord-mcp access help" for access commands.
`)
}

function printAccessHelp(): void {
  process.stdout.write(`codex-discord-mcp access commands:

  show
  reset
  pair <code>
  policy <pairing|allowlist|disabled>
  allow-user <discord-user-id>
  remove-user <discord-user-id>
  allow-channel <channel-id> [--no-mention] [--allow-user <user-id>...]
  remove-channel <channel-id>
  ack <emoji|off>
  mention-pattern <list|add|remove> [regex]
`)
}

function valuesAfter(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1]) {
      values.push(args[i + 1])
      i += 1
    }
  }
  return values
}

function checkNodeVersion(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  return {
    ok: Number.isFinite(major) && major >= 20,
    value: process.version,
    message: major >= 20 ? undefined : 'Node.js 20 or newer is required',
  }
}

function checkCodexCommand(command: string): DoctorCheck {
  const result = spawn.sync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  })

  if (result.error) {
    return { ok: false, value: command, message: result.error.message }
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/)[0]
  if (result.status === 0) {
    return { ok: true, value: output || command }
  }

  return {
    ok: false,
    value: command,
    message: `exited with status ${result.status ?? 'unknown'}`,
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function exists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main().catch(err => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}

export function isDirectRun(entry = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!entry) return false
  return canonicalPath(entry) === canonicalPath(fileURLToPath(moduleUrl))
}

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}
