export type DmPolicy = 'pairing' | 'allowlist' | 'disabled'
export type ReplyToMode = 'off' | 'first' | 'all'
export type ChunkMode = 'length' | 'newline'

export type GroupPolicy = {
  requireMention: boolean
  allowUsers: string[]
}

export type PendingEntry = {
  senderId: string
  chatId: string
  username?: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type Access = {
  dmPolicy: DmPolicy
  allowUsers: string[]
  channels: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: ReplyToMode
  textChunkLimit?: number
  chunkMode?: ChunkMode
}

export type AttachmentMeta = {
  id: string
  name: string
  contentType?: string
  size: number
  url?: string
}

export type QueuedMessage = {
  id: string
  chatId: string
  messageId: string
  userId: string
  user: string
  content: string
  createdAt: string
  receivedAt: string
  source: 'discord'
  attachments: AttachmentMeta[]
  status: 'pending' | 'handled'
}

export type StatePaths = {
  stateDir: string
  envFile: string
  accessFile: string
  approvedDir: string
  botPidFile: string
  inboxDir: string
  queueFile: string
  threadsFile: string
}

export type ThreadMap = Record<string, string>
