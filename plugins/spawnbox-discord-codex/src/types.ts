export type Audience = "public" | "helpers" | "staff" | "private";
export type Inbound = {
  id: string;
  channelId: string;
  parentId?: string;
  guildId?: string;
  userId: string;
  username: string;
  content: string;
  timestamp: string;
  isDM: boolean;
  webhookId?: string;
  replyTo?: string;
  attachments: {
    id: string;
    name: string;
    size: number;
    url?: string;
    contentType?: string;
  }[];
  embeds: unknown[];
};
export type Job = {
  event: Inbound;
  conversation: string;
  attempts: number;
  lease: string;
};
export type ChannelPolicy = {
  audience: Audience;
  requireMention: boolean;
  allowUsers: string[];
};
export type HelpConfig = {
  destinations?: {
    bugForumId: string;
    featureForumId: string;
    supportCategoryId: string;
    helperApplicationsForumId: string;
  };
  schemaVersion: 1;
  projectRoot: string;
  botApplicationId: string;
  guildId: string;
  ownerIds: string[];
  dmAllowUsers: string[];
  channels: Record<string, ChannelPolicy>;
  diagnosticWebhooks: Record<string, string[]>;
  model: string;
  codexExecutable: string;
  codexHome: string;
  orchestratorRoot: string;
  maxConcurrency: number;
  memoryEmbeddings?: boolean;
  projectKnowledge?: boolean;
  catchupPageLimit: number;
};
