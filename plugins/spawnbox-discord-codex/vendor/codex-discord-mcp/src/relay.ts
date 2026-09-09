import { CodexRunner, codexOptionsFromEnv } from './codex.js'
import { DiscordBridge } from './discord.js'
import { warnUnsafeBotMode } from './safety.js'
import { installShutdownHandlers } from './shutdown.js'
import {
  acquireProcessLock,
  getStatePaths,
  listPendingMessages,
  loadStateEnv,
  markMessageHandled,
} from './state.js'
import type { QueuedMessage, StatePaths } from './types.js'

export async function runRelay(): Promise<void> {
  const paths = getStatePaths()
  loadStateEnv(paths)

  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) {
    throw new Error(
      `DISCORD_BOT_TOKEN is required. Set it in ${paths.envFile} or the process environment.`,
    )
  }

  const lock = acquireProcessLock(paths.botPidFile, 'codex-discord relay')
  const bridge = new DiscordBridge(token, paths)
  const codexOptions = codexOptionsFromEnv()
  warnUnsafeBotMode(codexOptions)
  const runner = new CodexRunner(codexOptions, paths)
  const chains = new Map<string, Promise<void>>()

  function enqueue(message: QueuedMessage): void {
    const previous = chains.get(message.chatId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => processMessage(bridge, runner, message, paths))

    chains.set(message.chatId, next)
    void next.finally(() => {
      if (chains.get(message.chatId) === next) chains.delete(message.chatId)
    })
  }

  bridge.on('message', message => enqueue(message as QueuedMessage))

  for (const pending of listPendingMessages(100, paths)) {
    enqueue(pending)
  }

  installShutdownHandlers({
    label: 'codex-discord relay',
    stop: async () => {
      try {
        await bridge.stop()
      } finally {
        lock.release()
      }
    },
  })
  try {
    await bridge.start()
    process.stderr.write('codex-discord relay: ready\n')
  } catch (err) {
    lock.release()
    throw err
  }
}

async function processMessage(
  bridge: DiscordBridge,
  runner: CodexRunner,
  message: QueuedMessage,
  paths: StatePaths,
): Promise<void> {
  const typing = setInterval(() => {
    void bridge.sendTyping(message.chatId).catch(() => {})
  }, 9000)
  typing.unref()

  try {
    void bridge.sendTyping(message.chatId).catch(() => {})
    const result = await runner.runForMessage(message)
    await sendResult(bridge, message, result.text, result.filePaths)
    await markMessageHandled(message.id, paths)
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    await bridge
      .sendMessage({
        chatId: message.chatId,
        text: `Codex run failed: ${trimForDiscord(text)}`,
        replyTo: message.messageId,
      })
      .catch(sendErr => {
        process.stderr.write(`codex-discord relay: failed to report error: ${sendErr}\n`)
      })
    await markMessageHandled(message.id, paths)
  } finally {
    clearInterval(typing)
  }
}

// Deliver the run result, falling back to a text-only reply if attaching
// fails — a bad file must not swallow the answer itself.
async function sendResult(
  bridge: DiscordBridge,
  message: QueuedMessage,
  text: string,
  files: string[],
): Promise<void> {
  try {
    await bridge.sendMessage({
      chatId: message.chatId,
      text,
      replyTo: message.messageId,
      files,
    })
  } catch (err) {
    if (files.length === 0) throw err
    process.stderr.write(
      `codex-discord relay: attaching ${files.length} file(s) failed, retrying text-only: ${err}\n`,
    )
    await bridge.sendMessage({
      chatId: message.chatId,
      text: `${text}\n\n(${files.length} generated file(s) could not be attached)`,
      replyTo: message.messageId,
    })
  }
}

function trimForDiscord(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 1500 ? `${trimmed.slice(0, 1500)}...` : trimmed
}
