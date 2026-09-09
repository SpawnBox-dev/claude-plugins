import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { codexHome } from './images.js'
import { findRolloutFileByThreadId, recoverImagesFromRolloutSince } from './rollout.js'

// Discord upload limits shared by the bridge send path and the relay's
// automatic attachment collection.
export const DISCORD_MAX_FILE_BYTES = 25 * 1024 * 1024
export const DISCORD_MAX_FILES_PER_MESSAGE = 10

// File types the relay is willing to auto-attach from the outbox. Deliberately
// documents/data/archives/media only: code, logs, dotfiles, and executables
// written during a run are not user deliverables.
const DELIVERABLE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg',
  'md', 'txt', 'html', 'htm', 'pdf', 'rtf', 'epub',
  'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'ics',
  'zip', 'tar', 'gz', 'tgz', '7z',
  'mp3', 'wav', 'ogg', 'm4a', 'flac',
  'mp4', 'webm', 'mov', 'mkv',
])

const OUTBOX_SCAN_DEPTH = 3

export function defaultOutboxDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_DISCORD_OUTBOX_DIR?.trim()
  if (override) return override
  return join(codexHome(env), 'discord_outbox')
}

// One outbox subdirectory per Discord channel, so concurrent runs in different
// channels cannot pick up each other's files. chatId is a snowflake, but
// sanitize anyway since it lands in a filesystem path.
export function channelOutboxDir(baseDir: string, chatId: string): string {
  return join(baseDir, chatId.replace(/[^0-9A-Za-z_-]/g, '_'))
}

export type RolloutPosition = {
  file?: string
  size: number
}

// Byte size of the resumed thread's rollout before the run starts. Everything
// appended past this offset was produced by the current run.
export function captureRolloutPosition(
  threadId: string | undefined,
  sessionsRoot?: string,
): RolloutPosition {
  if (!threadId) return { size: 0 }
  const file = findRolloutFileByThreadId(threadId, sessionsRoot)
  if (!file) return { size: 0 }
  try {
    return { file, size: statSync(file).size }
  } catch {
    return { file, size: 0 }
  }
}

// Deliverable files written under the outbox during the run (mtime-based),
// oldest first so multi-file outputs keep their natural order.
export function listRunDeliverables(
  dir: string,
  sinceMs: number,
  options: { limit?: number; maxBytes?: number } = {},
): string[] {
  const limit = options.limit ?? DISCORD_MAX_FILES_PER_MESSAGE
  const maxBytes = options.maxBytes ?? DISCORD_MAX_FILE_BYTES
  const found: { path: string; mtimeMs: number }[] = []
  collectDeliverables(dir, OUTBOX_SCAN_DEPTH, sinceMs, maxBytes, found)
  found.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return found.slice(0, Math.max(0, limit)).map(file => file.path)
}

function collectDeliverables(
  dir: string,
  depth: number,
  sinceMs: number,
  maxBytes: number,
  out: { path: string; mtimeMs: number }[],
): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }

  for (const name of names) {
    if (name.startsWith('.')) continue
    const path = join(dir, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      if (depth > 0) collectDeliverables(path, depth - 1, sinceMs, maxBytes, out)
      continue
    }
    if (!stat.isFile() || stat.mtimeMs < sinceMs) continue
    if (stat.size === 0 || stat.size > maxBytes) continue
    if (!isDeliverableName(name)) continue
    out.push({ path, mtimeMs: stat.mtimeMs })
  }
}

function isDeliverableName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return DELIVERABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

// Everything the finished run should attach to its Discord reply:
// images decoded from the rollout segment this run appended, plus deliverable
// files it wrote to the channel outbox. Capped to Discord's per-message limit.
export function collectRunAttachments(params: {
  threadId: string | undefined
  before: RolloutPosition
  outboxDir: string
  runStartMs: number
  limit?: number
  sessionsRoot?: string
  imagesOutDir?: string
}): string[] {
  const limit = Math.max(0, Math.min(params.limit ?? DISCORD_MAX_FILES_PER_MESSAGE, DISCORD_MAX_FILES_PER_MESSAGE))
  const paths: string[] = []

  if (params.threadId) {
    // The run usually appends to the rollout captured before it started; only
    // re-walk the sessions tree when the thread id changed (fresh session).
    const suffix = `-${params.threadId}.jsonl`
    const current = params.before.file?.endsWith(suffix)
      ? params.before.file
      : findRolloutFileByThreadId(params.threadId, params.sessionsRoot)
    if (current) {
      const offset = params.before.file === current ? params.before.size : 0
      for (const image of recoverImagesFromRolloutSince(current, offset, {
        limit,
        outDir: params.imagesOutDir,
      })) {
        if (image.size > 0 && image.size <= DISCORD_MAX_FILE_BYTES) paths.push(image.path)
      }
    }
  }

  paths.push(...listRunDeliverables(params.outboxDir, params.runStartMs, { limit }))

  const seen = new Set<string>()
  const merged: string[] = []
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    merged.push(path)
  }
  return merged.slice(0, limit)
}
