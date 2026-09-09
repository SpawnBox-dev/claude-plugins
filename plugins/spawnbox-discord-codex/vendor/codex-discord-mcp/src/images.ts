import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Codex's built-in image_gen tool renders an inline preview but only persists
// the file under `$CODEX_HOME/generated_images/`. The model is not handed the
// concrete path, so the bridge exposes a tool to recover it for attachments.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const DEFAULT_LIMIT = 1
const MAX_LIMIT = 50
const DEFAULT_MAX_DEPTH = 3

export type GeneratedImage = {
  path: string
  name: string
  size: number
  modifiedMs: number
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

export function generatedImagesDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_DISCORD_GENERATED_IMAGES_DIR?.trim()
  if (override) return override
  return join(codexHome(env), 'generated_images')
}

export function listGeneratedImages(
  options: { limit?: number; dir?: string; maxDepth?: number } = {},
): GeneratedImage[] {
  const dir = options.dir ?? generatedImagesDir()
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH

  const images: GeneratedImage[] = []
  collect(dir, maxDepth, images)
  images.sort((a, b) => b.modifiedMs - a.modifiedMs)
  return images.slice(0, limit)
}

function collect(dir: string, depth: number, out: GeneratedImage[]): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }

  for (const name of names) {
    const path = join(dir, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue // skip unreadable entries
    }

    if (stat.isDirectory()) {
      if (depth > 0) collect(path, depth - 1, out)
      continue
    }
    if (!stat.isFile() || !isImageName(name)) continue
    out.push({ path, name, size: stat.size, modifiedMs: stat.mtimeMs })
  }
}

function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}
