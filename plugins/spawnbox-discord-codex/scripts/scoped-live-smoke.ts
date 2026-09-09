// Explicit local operator fixture. Real Discord REST, no second Gateway or model.
// Creates an empty private category/room and a labelled disposable bot message.
// Never admits fabricated participant content to the running HELP service.
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { PermissionFlagsBits } from "discord.js";
import { loadConfig } from "../src/config";
import { Store } from "../src/store";
import { Operations } from "../src/operations";
import { accessFile } from "../src/policy";
import { DiscordBridge } from "../vendor/codex-discord-mcp/src/discord";
import { getStatePaths } from "../vendor/codex-discord-mcp/src/state";
const [configPath, rehearsalState, settingsPath] = process.argv.slice(2);
const config = loadConfig(configPath);
const fixture = JSON.parse(
  readFileSync(join(rehearsalState, "rehearsal-private.json"), "utf8"),
);
assert(config.channels[fixture.channelId]?.audience === "private");
const token = JSON.parse(readFileSync(settingsPath, "utf8")).env
  .DISCORD_HELP_BOT_TOKEN;
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
    throw new Error(`Fixture REST ${method} HTTP ${response.status}`);
  return response.status === 204 ? undefined : ((await response.json()) as any);
};
assert.equal((await api("/users/@me")).id, config.botApplicationId);
const parent = await api(`/channels/${fixture.channelId}`);
assert.equal(parent.guild_id, config.guildId);
assert(
  parent.permission_overwrites.some(
    (p: any) =>
      p.id === config.guildId &&
      (BigInt(p.deny) & PermissionFlagsBits.ViewChannel) !== 0n,
  ),
);
const state = mkdtempSync(join(tmpdir(), "help-scoped-live-"));
const store = new Store(join(state, "help.db"));
writeFileSync(join(state, "access.json"), JSON.stringify(accessFile(config)));
const bridge = new DiscordBridge(token, getStatePaths(state), {
  receive: async () => {},
  dmRecipient: () => undefined,
});
bridge.client.rest.setToken(token);
let category: any, room: any;
try {
  category = await api(`/guilds/${config.guildId}/channels`, "POST", {
    name: "codex-private-permission-fixture",
    type: 4,
    permission_overwrites: parent.permission_overwrites,
  });
  assert(config.destinations, "Private fixture destinations must already be configured");
  config.destinations = {
    ...config.destinations,
    supportCategoryId: category.id,
  };
  const id = String((BigInt(Date.now()) - 1420070400000n) << 22n);
  const event = {
    id,
    channelId: fixture.channelId,
    guildId: config.guildId,
    userId: config.ownerIds[0],
    username: "codex-private-permission-fixture",
    content: "LOCAL OPERATOR FIXTURE; no real inbound user message",
    timestamp: new Date().toISOString(),
    isDM: false,
    attachments: [],
    embeds: [],
  };
  store.receive(event, "private");
  const job = store.claim()!;
  store.bindThread(job.conversation, "local-fixture");
  const operations = new Operations(store, bridge, config, state);
  room = (await operations.call("local-fixture", "create_support", {
    key: "fixture",
    symptom: "Synthetic permission qualification; no real support case",
  })) as any;
  const actual = await api(`/channels/${room.channelId}`);
  assert.equal(actual.parent_id, category.id);
  assert.equal(
    actual.permission_overwrites.length,
    new Set([config.guildId, config.botApplicationId, ...config.ownerIds]).size,
  );
  const everyone = actual.permission_overwrites.find(
    (p: any) => p.id === config.guildId,
  );
  assert((BigInt(everyone.deny) & PermissionFlagsBits.ViewChannel) !== 0n);
  for (const member of [config.botApplicationId, ...config.ownerIds]) {
    const overwrite = actual.permission_overwrites.find(
      (p: any) => p.id === member,
    );
    assert(
      overwrite &&
        (BigInt(overwrite.allow) & PermissionFlagsBits.ViewChannel) !== 0n,
    );
  }
  assert.equal(
    (
      (await operations.call("local-fixture", "create_support", {
        key: "fixture",
        symptom: "Repeat",
      })) as any
    ).channelId,
    room.channelId,
  );
  store.complete(job, "silent:permission fixture complete");
  const message = await api(`/channels/${fixture.channelId}/messages`, "POST", {
    content:
      "[Synthetic Codex moderation test: disposable bot-owned message; no actual abuse.]",
    allowed_mentions: { parse: [] },
  });
  store.receive(
    { ...event, id: String(BigInt(id) + 1n), userId: fixture.webhookId },
    "private",
  );
  const moderation = store.claim()!;
  const deleted = (await operations.call("local-fixture", "moderate", {
    action: "delete_message",
    messageId: message.id,
    reason: "mass spam",
  })) as any;
  assert.equal(deleted.deleted, message.id);
  const evidence = store.db
    .query("SELECT detail FROM audit WHERE kind='moderation_archive'")
    .get() as any;
  assert(
    evidence.detail.includes(message.id) &&
      evidence.detail.includes("Synthetic Codex moderation test"),
  );
  const absent = await fetch(
    `https://discord.com/api/v10/channels/${fixture.channelId}/messages/${message.id}`,
    { headers: { Authorization: `Bot ${token}` } },
  );
  assert.equal(absent.status, 404);
  store.complete(moderation, "silent:disposable message deletion verified");
  console.log(
    JSON.stringify({
      ok: true,
      privateSupportPermissions: true,
      supportReuse: true,
      evidenceBeforeDelete: true,
      deletedMessageId: message.id,
      fixture: state,
    }),
  );
} finally {
  // Only delete this run's verified empty fixture room/category. Never a reused
  // production channel; the fresh local Store has no production dynamic rooms.
  if (room?.channelId && category?.id) {
    const actual = await api(`/channels/${room.channelId}`);
    const messages = await api(`/channels/${room.channelId}/messages?limit=1`);
    if (actual.parent_id === category.id && messages.length === 0) {
      await api(`/channels/${room.channelId}`, "DELETE");
      await api(`/channels/${category.id}`, "DELETE");
    }
  }
  await bridge.stop();
  store.close();
}
