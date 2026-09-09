import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const id = z.string().regex(/^\d{15,22}$/);
export const toolSchemas = {
  context: {},
  reply: {
    key: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,60}$/)
      .describe("Stable semantic key for this response; reuse on retry"),
    text: z.string().min(1).max(16000),
    replyTo: id.optional(),
  },
  no_reply: { reason: z.string().min(1).max(1000) },
  needs_operator: { reason: z.string().min(1).max(1000) },
  react: { messageId: id, emoji: z.string().min(1).max(100) },
  edit_message: { messageId: id, text: z.string().min(1).max(2000) },
  fetch_messages: {
    channelId: id.optional(),
    before: id.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  list_channels: {},
  create_support: {
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    symptom: z.string().min(1).max(500),
  },
  create_forum_post: {
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    forum: z.enum(["bug", "feature"]),
    title: z.string().min(1).max(100),
    text: z.string().min(1).max(2000),
  },
  send_file: {
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    name: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}\.(txt|md|csv|json)$/),
    content: z.string().min(1).max(64000),
    caption: z.string().min(1).max(2000),
  },
  download_attachment: { messageId: id, attachmentId: id },
  read_resource: {
    kind: z.enum(["skill", "policy", "source", "user-note", "channel-note"]),
    name: z.string().max(300).optional(),
    offset: z
      .number()
      .int()
      .min(0)
      .max(1024 * 1024)
      .optional(),
  },
  record_note: { content: z.string().min(1).max(12000) },
  member_info: { userId: id.optional() },
  diagnostic: {
    action: z.enum([
      "versions",
      "metadata",
      "inventory",
      "read_member",
      "screenshot",
    ]),
    packageId: z
      .string()
      .regex(/^diag-(?:[a-f0-9]{8}-[a-f0-9]{3}|\d{10})$/)
      .optional(),
    member: z.string().max(300).optional(),
    offset: z
      .number()
      .int()
      .min(0)
      .max(32 * 1024 * 1024)
      .optional(),
    index: z.number().int().min(0).max(99).optional(),
  },
  forum_action: {
    action: z.enum(["archive", "tags"]),
    tags: z.array(id).max(5).default([]),
    removeTags: z.array(id).max(5).optional(),
    reason: z.string().min(1).max(500),
  },
  moderate: {
    action: z.enum(["delete_message", "timeout"]),
    messageId: id.optional(),
    userId: id.optional(),
    minutes: z.number().int().min(1).max(60).optional(),
    reason: z.enum([
      "credential leak",
      "malware",
      "scam",
      "mass spam",
      "explicit harmful content",
    ]),
  },
};
const descriptions: Record<keyof typeof toolSchemas, string> = {
  context:
    "Read trusted current Discord sender, audience, event and delivery receipt. Call first on every event.",
  reply:
    "Explicitly send text to the current conversation with durable receipts. No public output is sent automatically. Reuse the same key and content when retrying.",
  no_reply:
    "Intentionally remain silent and record why. Completes this event without a public message.",
  needs_operator:
    "Mark this event blocked for the local operator, with a specific reason. Use for missing capabilities, failed actions or unresolved delivery; do not disguise failures as deliberate silence.",
  react: "React to a message in the current conversation.",
  edit_message:
    "Edit one of this service's recorded replies in the current conversation.",
  fetch_messages:
    "Read a page of current conversation history, including embeds and attachments. Use nextBefore to continue.",
  download_attachment:
    "Fetch a Discord-hosted attachment from current conversation. Returns bounded text or image content and a recorded artifact.",
  read_resource:
    "Read an installed skill by name (kind=skill, name=discord-help), shared domain policy, scoped person/channel note or approved project source. Claude-specific mechanics in references are superseded by the Codex skills.",
  record_note:
    "Append evidence to this conversation's local audit trail. Use orchestrator for durable task memory.",
  list_channels:
    "List configured rooms and active forum threads this audience can read. Private rooms are excluded from public workers.",
  create_support:
    "Create or reuse a private support room for the verified current participant, using a fixed permission template. No arbitrary access changes.",
  create_forum_post:
    "File a public bug or feature report from a public conversation. Private context requires separate operator publication review.",
  send_file:
    "Send a generated text, Markdown, CSV or JSON attachment to the current conversation with durable receipts. Cannot read arbitrary local files.",
  member_info:
    "Read verified Discord member IDs and roles; usernames do not establish authority.",
  diagnostic:
    "Read deployed release versions or a diagnostic package shared in this private conversation. Fixed remote SELECT/get commands only; no arbitrary shell or SQL. Inventory includes logs; screenshots are fetched separately.",
  forum_action:
    "Archive current forum thread or merge valid tags without discarding other tags. Helper approval decisions require the local operator.",
  moderate:
    "Protective action for clear abuse only. Archives evidence before deleting a message; timeouts at most one hour. No bans, kicks or access-control changes.",
};
export function validateOperation(tool: string, args: unknown): any {
  const schema = toolSchemas[tool as keyof typeof toolSchemas];
  if (!schema) throw new Error("Unknown tool");
  return z.object(schema).strict().parse(args);
}
export async function startMcp() {
  const endpoint = process.env.SPAWNBOX_HELP_ENDPOINT;
  const token = process.env.SPAWNBOX_HELP_CLIENT_TOKEN;
  const url = endpoint ? new URL(endpoint) : undefined;
  if (url && (url.protocol !== "http:" || url.hostname !== "127.0.0.1"))
    throw new Error("HELP endpoint must be loopback HTTP");
  const server = new McpServer({
    name: "spawnbox-discord-codex",
    version: "0.1.0",
  });
  for (const [tool, schema] of Object.entries(toolSchemas)) {
    server.registerTool(
      tool,
      {
        description: descriptions[tool as keyof typeof toolSchemas],
        inputSchema: schema as z.ZodRawShape,
      },
      async (args, extra): Promise<CallToolResult> => {
        const threadId = extra._meta?.threadId;
        if (!url || !token)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "HELP service is not connected. This plugin does not start a bot on installation; use its local setup/start commands.",
              },
            ],
          };
        if (typeof threadId !== "string" || !threadId)
          return {
            isError: true,
            content: [
              { type: "text", text: "Native Codex task identity is required" },
            ],
          };
        try {
          const response = await fetch(new URL("/operation", url), {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ threadId, tool, args }),
            signal: AbortSignal.timeout(60000),
          });
          const value = (await response.json()) as any;
          if (!response.ok)
            throw new Error(
              value.error || `HELP operation HTTP ${response.status}`,
            );
          const content: any[] = [];
          if (value?.image) {
            content.push({ type: "image", ...value.image });
            delete value.image;
          }
          content.unshift({ type: "text", text: JSON.stringify(value) });
          return { content };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: String(error) }],
          };
        }
      },
    );
  }
  await server.connect(new StdioServerTransport());
}
if (import.meta.main) await startMcp();
