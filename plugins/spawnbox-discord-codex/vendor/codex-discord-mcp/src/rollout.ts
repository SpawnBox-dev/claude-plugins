import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import { codexHome, generatedImagesDir } from './images.js'

// Codex's built-in image_gen renders an inline preview and (often) writes NO
// file to disk — the image only survives as base64 inside the session rollout
// JSONL, on lines where payload.type === 'image_generation_call'. This module
// recovers those images so they can be attached to Discord.

const MIN_RESULT_LEN = 32 // skip trivially short strings; magic-byte check does the real validation
const DEFAULT_MAX_DEPTH = 4
const MAX_COUNT = 10

export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), 'sessions')
}

// Newest rollout JSONL by mtime under the sessions tree (recursive, bounded).
// The active session is the most-recently-written rollout.
export function newestRolloutFile(
  dir: string = sessionsDir(),
  maxDepth = DEFAULT_MAX_DEPTH,
): string | undefined {
  let best: { path: string; mtimeMs: number } | undefined
  walk(dir, maxDepth, path => {
    const name = basename(path)
    if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) return
    try {
      const mtimeMs = statSync(path).mtimeMs
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs }
    } catch {
      // unreadable entry
    }
  })
  return best?.path
}

// Rollout filenames end with the session/thread id (`rollout-<ts>-<id>.jsonl`),
// which is the id `codex exec --json` reports in its thread.started event.
export function findRolloutFileByThreadId(
  threadId: string,
  dir: string = sessionsDir(),
  maxDepth = DEFAULT_MAX_DEPTH,
): string | undefined {
  if (!/^[0-9a-f-]+$/i.test(threadId)) return undefined
  const suffix = `-${threadId}.jsonl`
  let best: { path: string; mtimeMs: number } | undefined
  walk(dir, maxDepth, path => {
    const name = basename(path)
    if (!name.startsWith('rollout-') || !name.endsWith(suffix)) return
    try {
      const mtimeMs = statSync(path).mtimeMs
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs }
    } catch {
      // unreadable entry
    }
  })
  return best?.path
}

function walk(dir: string, depth: number, onFile: (path: string) => void): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (depth > 0) walk(path, depth - 1, onFile)
    } else if (st.isFile()) {
      onFile(path)
    }
  }
}

export type RolloutImage = {
  buffer: Buffer
  ext: string
  status?: string
  revisedPrompt?: string
}

// Extract image_generation_call results from rollout JSONL text, oldest first,
// de-duplicated by content. Pure over the text for testability.
export function extractImagesFromRolloutText(text: string): RolloutImage[] {
  const out: RolloutImage[] = []
  const seen = new Set<string>()

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    if (!trimmed.includes('image_generation_call')) continue // cheap pre-filter

    let event: { payload?: { type?: string; result?: unknown; status?: string; revised_prompt?: string } }
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue // partial/last line being written, or non-JSON
    }

    const payload = event.payload
    if (!payload || payload.type !== 'image_generation_call') continue
    const result = payload.result
    if (typeof result !== 'string' || result.length < MIN_RESULT_LEN) continue

    const key = `${result.length}:${result.slice(0, 48)}`
    if (seen.has(key)) continue

    let buffer: Buffer
    try {
      buffer = Buffer.from(result, 'base64')
    } catch {
      continue
    }
    const ext = imageExt(buffer)
    if (!ext) continue

    seen.add(key)
    out.push({
      buffer,
      ext,
      status: typeof payload.status === 'string' ? payload.status : undefined,
      revisedPrompt:
        typeof payload.revised_prompt === 'string' ? payload.revised_prompt : undefined,
    })
  }

  return out
}

export function imageExt(buf: Buffer): string | undefined {
  if (buf.length < 12) return undefined
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return undefined
}

export type RecoveredImage = {
  path: string
  name: string
  size: number
  ext: string
  status?: string
  revisedPrompt?: string
}

// Recover the most recent `count` images from the (newest or given) rollout,
// write them to the generated-images dir, and return their absolute paths.
export function recoverGeneratedImages(
  options: { count?: number; sessionFile?: string; outDir?: string } = {},
): { rolloutFile?: string; images: RecoveredImage[] } {
  const count = Math.max(1, Math.min(options.count ?? 1, MAX_COUNT))
  const rolloutFile = options.sessionFile ?? newestRolloutFile()
  if (!rolloutFile) return { images: [] }

  let text: string
  try {
    text = readFileSync(rolloutFile, 'utf8')
  } catch {
    return { rolloutFile, images: [] }
  }

  const chosen = extractImagesFromRolloutText(text).slice(-count)
  return { rolloutFile, images: writeRecoveredImages(chosen, options.outDir) }
}

// Read the rollout from a byte offset (the pre-run file size), so a run only
// pays for what it appended — resumed rollouts grow to tens of MB. An offset
// past EOF means the file was replaced or truncated; re-read it in full.
export function readRolloutTextFrom(path: string, offset: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = offset > size ? 0 : Math.max(0, offset)
    const length = size - start
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const bytes = readSync(fd, buffer, read, length - read, start + read)
      if (bytes <= 0) break
      read += bytes
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// Recover only the images that appeared after `offset` — i.e. the ones the
// current run generated — and write them to the generated-images dir.
export function recoverImagesFromRolloutSince(
  rolloutFile: string,
  offset: number,
  options: { limit?: number; outDir?: string } = {},
): RecoveredImage[] {
  let text: string
  try {
    text = readRolloutTextFrom(rolloutFile, offset)
  } catch {
    return []
  }
  if (!text) return []

  const limit = Math.max(1, Math.min(options.limit ?? MAX_COUNT, MAX_COUNT))
  return writeRecoveredImages(extractImagesFromRolloutText(text).slice(-limit), options.outDir)
}

function writeRecoveredImages(
  images: RolloutImage[],
  outDir = generatedImagesDir(),
): RecoveredImage[] {
  if (images.length === 0) return []
  mkdirSync(outDir, { recursive: true, mode: 0o700 })

  const stamp = Date.now()
  const nonce = randomBytes(3).toString('hex')
  return images.map((img, i) => {
    const name = `recovered-${stamp}-${nonce}-${i + 1}.${img.ext}`
    const path = join(outDir, name)
    writeFileSync(path, img.buffer, { mode: 0o600 })
    return {
      path,
      name,
      size: img.buffer.length,
      ext: img.ext,
      status: img.status,
      revisedPrompt: img.revisedPrompt,
    }
  })
}
