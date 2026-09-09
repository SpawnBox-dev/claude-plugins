// Explicit operator rehearsal only. Production routing and Claude state are never
// edited. Secrets stay in the local state directory, not in output or arguments.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { deflateSync } from "node:zlib";
const [action, baselinePath, stateArg, settingsPath, text] =
  process.argv.slice(2);
if (!baselinePath || !stateArg || !settingsPath)
  throw new Error(
    "rehearsal.ts provision|probe <baseline-config> <test-state> <help-settings> [probe-text]",
  );
const baseline = loadConfig(baselinePath),
  state = resolve(stateArg);
mkdirSync(state, { recursive: true });
const token = JSON.parse(readFileSync(settingsPath, "utf8")).env
  ?.DISCORD_HELP_BOT_TOKEN;
if (!token) throw new Error("HELP token missing");
const api = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`Discord rehearsal ${method}: HTTP ${response.status}`);
  return response.status === 204 ? undefined : ((await response.json()) as any);
};
const identity = await api("/users/@me");
if (identity.id !== baseline.botApplicationId)
  throw new Error("Wrong bot identity");
const recordPath = join(state, "rehearsal-private.json");
if (action === "verify") {
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const threadId = process.argv[6];
  if (!/^\d{15,22}$/.test(threadId || ""))
    throw new Error("Fixture thread ID required");
  const thread = await api(`/channels/${threadId}`);
  if (thread.parent_id !== record.forumId)
    throw new Error("Not the private fixture forum");
  const messages = await api(`/channels/${threadId}/messages?limit=20`);
  const file = await api(
    `/channels/${record.channelId}/messages/1546958654110957701`,
  );
  const request = await api(
    `/channels/${record.channelId}/messages/1546958501144698982`,
  );
  console.log(
    JSON.stringify(
      {
        thread: {
          id: thread.id,
          archived: thread.thread_metadata?.archived,
          tags: thread.applied_tags,
        },
        replies: messages
          .filter((m: any) => m.author.id === baseline.botApplicationId)
          .map((m: any) => ({ id: m.id, content: m.content })),
        file: {
          id: file.id,
          content: file.content,
          attachments: file.attachments.map((a: any) => ({
            name: a.filename,
            size: a.size,
          })),
        },
        reactions: request.reactions?.map((r: any) => ({
          emoji: r.emoji.name,
          count: r.count,
          me: r.me,
        })),
      },
      null,
      2,
    ),
  );
} else if (action === "provision") {
  if (existsSync(recordPath)) {
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    console.log(
      JSON.stringify({
        existing: true,
        channelId: record.channelId,
        url: `https://discord.com/channels/${baseline.guildId}/${record.channelId}`,
      }),
    );
    process.exit(0);
  }
  const channel = await api(`/guilds/${baseline.guildId}/channels`, "POST", {
    name: "codex-help-rehearsal",
    type: 0,
    topic:
      "[spawnbox-codex-rehearsal] Isolated HELP bridge qualification. Claude routing is unchanged.",
    permission_overwrites: [
      { id: baseline.guildId, type: 0, deny: "1024" },
      ...baseline.ownerIds.map((id) => ({ id, type: 1, allow: "379968" })),
      { id: baseline.botApplicationId, type: 1, allow: "535260305984" },
    ],
  });
  // Record immediately so a subsequent failure does not orphan an unknown room.
  writeFileSync(recordPath, JSON.stringify({ channelId: channel.id }, null, 2));
  const webhook = await api(`/channels/${channel.id}/webhooks`, "POST", {
    name: "Codex HELP test input",
  });
  writeFileSync(
    recordPath,
    JSON.stringify(
      {
        channelId: channel.id,
        webhookId: webhook.id,
        webhookToken: webhook.token,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const config = {
    ...baseline,
    codexHome: join(state, "codex-home"),
    channels: {
      [channel.id]: {
        audience: "private",
        requireMention: false,
        allowUsers: baseline.ownerIds,
      },
    },
    dmAllowUsers: [],
    diagnosticWebhooks: { [channel.id]: [webhook.id] },
    maxConcurrency: 1,
  };
  writeFileSync(join(state, "config.json"), JSON.stringify(config, null, 2));
  console.log(
    JSON.stringify({
      created: true,
      channelId: channel.id,
      url: `https://discord.com/channels/${baseline.guildId}/${channel.id}`,
      routing: "Only this room; DMs disabled",
      started: false,
    }),
  );
} else if (action === "forum") {
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  if (record.forumId) {
    console.log(
      JSON.stringify({
        forumId: record.forumId,
        textChannelId: record.publicFixtureChannelId,
        existing: true,
      }),
    );
    process.exit(0);
  }
  const overwrites = [
    { id: baseline.guildId, type: 0, deny: "1024" },
    ...baseline.ownerIds.map((id) => ({ id, type: 1, allow: "379968" })),
    { id: baseline.botApplicationId, type: 1, allow: "535260305984" },
  ];
  const forum = await api(`/guilds/${baseline.guildId}/channels`, "POST", {
    name: "codex-help-test-forum",
    type: 15,
    topic:
      "Private integration fixture. Content follows public support rules; no production reports.",
    permission_overwrites: overwrites,
    available_tags: [
      { name: "Open", moderated: false },
      { name: "Resolved", moderated: false },
    ],
  });
  record.forumId = forum.id;
  record.forumTags = forum.available_tags;
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  const fixtureChannel = await api(
    `/guilds/${baseline.guildId}/channels`,
    "POST",
    {
      name: "codex-help-test-public-policy",
      type: 0,
      topic:
        "Private integration fixture exercising the strict public audience policy.",
      permission_overwrites: overwrites,
    },
  );
  const publicWebhook = await api(
    `/channels/${fixtureChannel.id}/webhooks`,
    "POST",
    { name: "Codex forum test input" },
  );
  const forumWebhook = await api(`/channels/${forum.id}/webhooks`, "POST", {
    name: "Codex thread test input",
  });
  Object.assign(record, {
    publicFixtureChannelId: fixtureChannel.id,
    publicWebhookId: publicWebhook.id,
    publicWebhookToken: publicWebhook.token,
    forumWebhookId: forumWebhook.id,
    forumWebhookToken: forumWebhook.token,
  });
  writeFileSync(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  const config = loadConfig(join(state, "config.json"));
  for (const id of [forum.id, fixtureChannel.id])
    config.channels[id] = {
      audience: "public",
      requireMention: false,
      allowUsers: baseline.ownerIds,
    };
  config.diagnosticWebhooks[fixtureChannel.id] = [publicWebhook.id];
  config.diagnosticWebhooks[forum.id] = [forumWebhook.id];
  config.destinations = {
    bugForumId: forum.id,
    featureForumId: forum.id,
    supportCategoryId: "1471750328205447240",
    helperApplicationsForumId: "1494801214934614046",
  };
  writeFileSync(join(state, "config.json"), JSON.stringify(config, null, 2));
  console.log(
    JSON.stringify({
      forumId: forum.id,
      textChannelId: fixtureChannel.id,
      tags: record.forumTags.map((t: any) => ({ id: t.id, name: t.name })),
      requiresServiceRestart: true,
    }),
  );
} else if (action === "probe-forum-create" || action === "probe-thread") {
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  if (!text) throw new Error("Explicit probe text required");
  const thread = process.argv[7];
  if (action === "probe-thread" && !/^\d{15,22}$/.test(thread || ""))
    throw new Error("Thread ID required");
  const target =
    action === "probe-thread"
      ? `/webhooks/${record.forumWebhookId}/${record.forumWebhookToken}?wait=true&thread_id=${thread}`
      : `/webhooks/${record.publicWebhookId}/${record.publicWebhookToken}?wait=true`;
  const result = await api(target, "POST", {
    content: text,
    allowed_mentions: { parse: [] },
  });
  console.log(
    JSON.stringify({
      sent: true,
      messageId: result.id,
      channelId: result.channel_id,
    }),
  );
} else if (
  action === "probe" ||
  action === "probe-embed" ||
  action === "probe-file" ||
  action === "probe-image"
) {
  if (!text) throw new Error("Explicit probe text is required");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  let result: any;
  if (action === "probe-file" || action === "probe-image") {
    const form = new FormData();
    form.set(
      "payload_json",
      JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
    );
    if (action === "probe-file")
      form.set(
        "files[0]",
        new Blob(
          ["Harmless integration test attachment. The marker is quartz.\n"],
          { type: "text/plain" },
        ),
        "rehearsal-note.txt",
      );
    else {
      // A deterministic solid-color protocol fixture, not an edited user image.
      const crc = (data: Buffer) => {
        let value = 0xffffffff;
        for (const byte of data) {
          value ^= byte;
          for (let i = 0; i < 8; i++)
            value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
        }
        return (value ^ 0xffffffff) >>> 0;
      };
      const chunk = (name: string, data: Buffer) => {
        const type = Buffer.from(name),
          length = Buffer.alloc(4),
          checksum = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
        return Buffer.concat([length, type, data, checksum]);
      };
      const header = Buffer.alloc(13);
      header.writeUInt32BE(32, 0);
      header.writeUInt32BE(32, 4);
      header[8] = 8;
      header[9] = 2;
      const pixels = Buffer.alloc(32 * (1 + 32 * 3));
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) pixels[y * 97 + 1 + x * 3 + 2] = 255;
      const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels)),
        chunk("IEND", Buffer.alloc(0)),
      ]);
      form.set(
        "files[0]",
        new Blob([png], { type: "image/png" }),
        "rehearsal-image.png",
      );
    }
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${record.webhookId}/${record.webhookToken}?wait=true`,
      { method: "POST", body: form },
    );
    if (!response.ok)
      throw new Error(`Attachment rehearsal HTTP ${response.status}`);
    result = await response.json();
  } else
    result = await api(
      `/webhooks/${record.webhookId}/${record.webhookToken}?wait=true`,
      "POST",
      action === "probe-embed"
        ? {
            embeds: [
              { title: "Synthetic integration test", description: text },
            ],
            allowed_mentions: { parse: [] },
          }
        : { content: text, allowed_mentions: { parse: [] } },
    );
  console.log(
    JSON.stringify({
      sent: true,
      messageId: result.id,
      channelId: record.channelId,
    }),
  );
} else throw new Error("Unknown rehearsal action");
