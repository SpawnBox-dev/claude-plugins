import type { ChunkMode } from './types.js'

export const DISCORD_TEXT_LIMIT = 2000

export function splitDiscordText(
  text: string,
  limit = DISCORD_TEXT_LIMIT,
  mode: ChunkMode = 'newline',
): string[] {
  const safeLimit = Math.max(1, Math.min(limit, DISCORD_TEXT_LIMIT))
  if (text.length <= safeLimit) return [text]

  const chunks: string[] = []
  let rest = text

  while (rest.length > safeLimit) {
    let cut = safeLimit

    if (mode === 'newline') {
      const paragraph = rest.lastIndexOf('\n\n', safeLimit)
      const line = rest.lastIndexOf('\n', safeLimit)
      const space = rest.lastIndexOf(' ', safeLimit)
      cut =
        paragraph > safeLimit / 2
          ? paragraph
          : line > safeLimit / 2
            ? line
            : space > 0
              ? space
              : safeLimit
    }

    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
    // Drop the boundary separator itself: one space for a word cut, the blank
    // line(s) for a newline cut. Deeper indentation is preserved.
    rest = rest.startsWith(' ') ? rest.slice(1) : rest.replace(/^\n+/, '')
  }

  if (rest.length > 0) chunks.push(rest)
  return chunks
}

export function sanitizeOneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}
