import type { HelpConfig, Inbound, Audience } from "./types";
import type { Message } from "discord.js";
import { ChannelType } from "discord.js";
import {
  channelGateDecision,
  channelSendAllowed,
} from "../vendor/codex-discord-mcp/src/discord";

export function envelope(message: Message): Inbound {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? undefined,
    parentId: message.channel.isThread()
      ? (message.channel.parentId ?? undefined)
      : undefined,
    userId: message.author.id,
    username: message.author.username,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    isDM: message.channel.type === ChannelType.DM,
    webhookId: message.webhookId ?? undefined,
    replyTo: message.reference?.messageId,
    attachments: [...message.attachments.values()].map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      url: a.url,
      contentType: a.contentType ?? undefined,
    })),
    embeds: message.embeds.map((e) => e.toJSON()),
  };
}
export function admit(
  config: HelpConfig,
  event: Inbound,
  authorBot: boolean,
  self: string,
  mentioned: boolean,
): Audience | undefined {
  if (event.userId === self) return;
  if (event.isDM) {
    if (
      authorBot ||
      event.webhookId ||
      !config.dmAllowUsers.includes(event.userId)
    )
      return;
    return "private";
  }
  if (event.guildId !== config.guildId) return;
  const policy = config.channels[event.parentId || event.channelId];
  if (!policy) return;
  if (authorBot || event.webhookId) {
    if (
      !event.webhookId ||
      !(
        config.diagnosticWebhooks[event.parentId || event.channelId] || []
      ).includes(event.webhookId)
    )
      return;
    return policy.audience;
  }
  // Reuse upstream's allowlist and mention semantics; only trusted Discord metadata
  // reaches this function. Text that resembles a source marker has no authority.
  const access = {
    dmPolicy: "allowlist" as const,
    allowUsers: config.dmAllowUsers,
    pending: {},
    channels: config.channels,
  };
  const decision = channelGateDecision(
    access,
    event.parentId || event.channelId,
    event.userId,
  );
  return decision === "pass" && (!policy.requireMention || mentioned)
    ? policy.audience
    : undefined;
}
export function accessFile(config: HelpConfig) {
  return {
    dmPolicy: "allowlist",
    allowUsers: config.dmAllowUsers,
    channels: config.channels,
    pending: {},
    textChunkLimit: 2000,
    replyToMode: "first",
  };
}
export function assertDestination(
  config: HelpConfig,
  event: Inbound,
  channel: string,
) {
  // Cross-audience posting is a separate, terminal-authorized operation. The
  // conversation worker cannot choose an arbitrary guild channel or DM target.
  if (channel !== event.channelId)
    throw new Error("Destination is outside this conversation");
  const access = accessFile(config);
  if (
    !channelSendAllowed(
      access as any,
      event.isDM
        ? { isDm: true, recipientUserId: event.userId }
        : { isDm: false, channelId: event.parentId || event.channelId },
    )
  )
    throw new Error("Destination is no longer admitted");
}
export function canRead(
  config: HelpConfig,
  event: Inbound,
  audience: string,
  channel: string,
  parent?: string,
): boolean {
  if (channel === event.channelId) return true;
  const target = config.channels[parent || channel]?.audience;
  if (!target || event.isDM || audience === "private") return false;
  return target === "public" || (audience === "staff" && target !== "private");
}
