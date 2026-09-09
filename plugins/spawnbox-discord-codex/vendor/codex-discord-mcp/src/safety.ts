import type { CodexRunnerOptions } from './codex.js'

export function buildUnsafeBotModeWarning(
  options: Pick<CodexRunnerOptions, 'sandbox' | 'approvalPolicy'>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isTruthy(env.CODEX_DISCORD_ASSUME_YES)) return undefined
  if (options.approvalPolicy !== 'never') return undefined
  if (options.sandbox === 'read-only') return undefined

  return [
    'WARNING: codex-discord-mcp bot is running unattended with writable Codex access.',
    `CODEX_SANDBOX=${options.sandbox}`,
    'CODEX_APPROVAL_POLICY=never',
    '',
    'Discord messages are untrusted input. Approved Discord users can trigger Codex runs that may edit files.',
    'Use read-only for first runs, or run workspace-write only in an isolated repository or disposable worktree.',
    'Set CODEX_DISCORD_ASSUME_YES=true to suppress this warning.',
  ].join('\n')
}

export function warnUnsafeBotMode(
  options: Pick<CodexRunnerOptions, 'sandbox' | 'approvalPolicy'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const warning = buildUnsafeBotModeWarning(options, env)
  if (warning) process.stderr.write(`${warning}\n`)
}

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '')
}
