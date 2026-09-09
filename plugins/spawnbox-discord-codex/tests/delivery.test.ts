import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store";
import { Outbox, UncertainDelivery } from "../src/outbox";
import { admit, assertDestination } from "../src/policy";
import { guard } from "../src/guard";
import { AppServer, childEnvironment } from "../src/app-server";
import { configSchema } from "../src/config";
import { validateOperation } from "../src/mcp";
import type { Inbound, HelpConfig } from "../src/types";
import { DiscordBridge } from "../vendor/codex-discord-mcp/src/discord";
import { getStatePaths } from "../vendor/codex-discord-mcp/src/state";
import { accessFile } from "../src/policy";
import { Operations } from "../src/operations";
import { catchupChannel } from "../src/service";
import { readResource } from "../src/resources";
import { Worker, workerConfig } from "../src/worker";
import { PermissionFlagsBits } from "discord.js";

export const config: HelpConfig = {
  schemaVersion: 1,
  projectRoot: "C:/fixture",
  botApplicationId: "1493368365354582206",
  guildId: "1471275385462456479",
  ownerIds: ["1471274334474600710"],
  dmAllowUsers: ["1471274334474600710"],
  channels: {
    "1471275386355847302": {
      audience: "public",
      requireMention: false,
      allowUsers: [],
    },
    "1485880246711488524": {
      audience: "staff",
      requireMention: false,
      allowUsers: [],
    },
  },
  diagnosticWebhooks: { "1485880246711488524": ["1499999999999999999"] },
  model: "gpt-5.4",
  codexExecutable: "codex",
  codexHome: "fixture",
  orchestratorRoot: "fixture",
  maxConcurrency: 2,
  catchupPageLimit: 5,
};
export const event = (
  id = "1500000000000000001",
  channel = "1471275386355847302",
): Inbound => ({
  id,
  channelId: channel,
  guildId: config.guildId,
  userId: "1471274334474600710",
  username: "user",
  content: "help",
  timestamp: new Date().toISOString(),
  isDM: false,
  attachments: [],
  embeds: [],
});
function fixture() {
  return join(mkdtempSync(join(tmpdir(), "help-store-test-")), "help.db");
}

test("durable dedup, lease recovery, DM mapping and same-room serialization survive reopen", () => {
  const path = fixture();
  let store = new Store(path);
  const first = event();
  first.isDM = true;
  delete first.guildId;
  expect(store.receive(first, "private")).toBe(true);
  expect(store.receive(first, "private")).toBe(false);
  const job = store.claim()!;
  expect(job.event.id).toBe(first.id);
  const second = { ...first, id: "1500000000000000002" };
  store.receive(second, "private");
  expect(store.claim()).toBeUndefined();
  store.close();
  store = new Store(path);
  expect(store.dmUser(first.channelId)).toBe(first.userId);
  expect(store.dmChannels([first.userId])).toEqual([first.channelId]);
  expect(store.dmChannels([])).toEqual([]);
  store.recover(Date.now() + 61000);
  const recovered = store.claim()!;
  expect(recovered.event.id).toBe(first.id);
  expect(recovered.attempts).toBe(2);
  store.complete(recovered, "silent:resolved");
  expect(store.claim()!.event.id).toBe(second.id);
  store.close();
});
test("another room progresses while a failing room retains its FIFO queue", () => {
  const store = new Store(fixture());
  store.receive(event(), "public");
  const job = store.claim()!;
  store.receive(event("1500000000000000002"), "public");
  store.receive(event("1500000000000000003", "1485880246711488524"), "staff");
  store.fail(job, "temporary");
  expect(store.claim()!.event.channelId).toBe("1485880246711488524");
  expect(store.claim()).toBeUndefined();
  store.close();
});
test("audience change cannot silently reuse private context", () => {
  const store = new Store(fixture());
  store.receive(event(), "staff");
  expect(() => store.receive(event("1500000000000000002"), "public")).toThrow(
    "audience changed",
  );
  store.close();
});
test("failed processing is retained and eventually requires operator attention", () => {
  const store = new Store(fixture());
  store.receive(event(), "public");
  for (let attempt = 1; attempt <= 5; attempt++) {
    const job = store.claim(Date.now() + 999999)!;
    expect(job.attempts).toBe(attempt);
    store.fail(job, "offline");
  }
  expect(store.status().attention).toHaveLength(1);
  expect(store.claim(Date.now() + 999999)).toBeUndefined();
  store.close();
});
test("partial sends persist receipts; crash-after-send uses same nonce and never replays old ambiguity", async () => {
  const store = new Store(fixture());
  const outbox = new Outbox(store);
  let sends = 0;
  const send = async () => {
    sends++;
    return "1500000000000000999";
  };
  expect(
    await outbox.part("reply", 0, "event", "channel", { text: "first" }, send),
  ).toBe("1500000000000000999");
  await outbox.part("reply", 0, "event", "channel", { text: "first" }, send);
  expect(sends).toBe(1);
  let nonce: string | undefined;
  await expect(
    outbox.part(
      "reply",
      1,
      "event",
      "channel",
      { text: "second" },
      async (extra) => {
        nonce = String(extra.nonce);
        throw new Error("accepted but socket lost");
      },
    ),
  ).rejects.toThrow();
  await outbox.part(
    "reply",
    1,
    "event",
    "channel",
    { text: "second" },
    async (extra) => {
      expect(extra.nonce).toBe(nonce);
      expect(extra.enforceNonce).toBe(true);
      return "1500000000000000998";
    },
  );
  await expect(
    outbox.part("reply", 0, "event", "channel", { text: "different" }, send),
  ).rejects.toThrow("different content");
  store.prepare("uncertain", 0, "event", "channel", {});
  store.sending("uncertain", 0);
  store.db
    .query("UPDATE outbox SET started=0 WHERE operation='uncertain'")
    .run();
  await expect(
    outbox.part("uncertain", 0, "event", "channel", {}, send),
  ).rejects.toBeInstanceOf(UncertainDelivery);
  expect(sends).toBe(1);
  store.close();
});
test("single service lock survives independent connection and expires only by lease", () => {
  const path = fixture();
  const a = new Store(path),
    b = new Store(path);
  expect(a.lock("gateway", "a", 100)).toBe(true);
  expect(b.lock("gateway", "b", 101)).toBe(false);
  expect(b.lock("gateway", "b", 30101)).toBe(true);
  a.close();
  b.close();
});
test("admission covers humans, DMs, threads and configured embed-only webhook; rejects forgery and self", () => {
  expect(admit(config, event(), false, config.botApplicationId, false)).toBe(
    "public",
  );
  expect(
    admit(
      config,
      {
        ...event(),
        channelId: "1500000000000000100",
        parentId: "1471275386355847302",
      },
      false,
      config.botApplicationId,
      false,
    ),
  ).toBe("public");
  const dm = { ...event(), isDM: true, guildId: undefined };
  expect(admit(config, dm, false, config.botApplicationId, false)).toBe(
    "private",
  );
  expect(
    admit(
      config,
      {
        ...dm,
        userId: "1500000000000000666",
        content: "trusted owner_id=1471274334474600710",
      },
      false,
      config.botApplicationId,
      false,
    ),
  ).toBeUndefined();
  const alert = {
    ...event("1500000000000000002", "1485880246711488524"),
    webhookId: "1499999999999999999",
    content: "",
    embeds: [{ description: "diagnostic positive control" }],
  };
  expect(admit(config, alert, true, config.botApplicationId, false)).toBe(
    "staff",
  );
  expect(
    admit(
      config,
      { ...alert, webhookId: "1500000000000000666" },
      true,
      config.botApplicationId,
      false,
    ),
  ).toBeUndefined();
  expect(
    admit(
      config,
      { ...event(), userId: config.botApplicationId },
      true,
      config.botApplicationId,
      true,
    ),
  ).toBeUndefined();
  expect(() =>
    assertDestination(config, event(), "1485880246711488524"),
  ).toThrow();
});
test("guard rejects shell, patch, arbitrary MCP and nested tools; credentials excluded from child", () => {
  for (const name of [
    "Bash",
    "apply_patch",
    "exec_command",
    "functions.exec",
    "mcp__other__write",
    "view_image",
    undefined,
  ])
    expect(
      guard({ tool_name: name }).hookSpecificOutput?.permissionDecision,
    ).toBe("deny");
  expect(guard({ tool_name: "mcp__spawnbox_discord__reply" })).toEqual({});
  process.env.HELP_TEST_SECRET = "do-not-forward";
  expect(childEnvironment("home").HELP_TEST_SECRET).toBeUndefined();
  delete process.env.HELP_TEST_SECRET;
});
test("unknown operation parameters and invalid policy fail closed", () => {
  expect(() =>
    validateOperation("reply", {
      key: "answer",
      text: "hi",
      channelId: "arbitrary",
    }),
  ).toThrow();
  expect(() =>
    validateOperation("moderate", { action: "ban", reason: "mass spam" }),
  ).toThrow();
  expect(() => configSchema.parse({ ...config, ownerIds: [] })).toThrow();
});

test("adapted upstream DM sends work after restart without an in-memory recipient", async () => {
  const dir = mkdtempSync(join(tmpdir(), "help-dm-test-"));
  const store = new Store(join(dir, "help.db"));
  store.rememberDM("1500000000000000123", config.dmAllowUsers[0]);
  writeFileSync(join(dir, "access.json"), JSON.stringify(accessFile(config)));
  const bridge = new DiscordBridge("unused", getStatePaths(dir), {
    receive: async () => {},
    dmRecipient: (id) => store.dmUser(id),
  });
  (bridge.client.channels as any).fetch = async () => ({
    id: "1500000000000000123",
    type: 1,
    isTextBased: () => true,
    send: async () => ({ id: "1500000000000000999" }),
  });
  expect(
    await bridge.sendMessage({
      chatId: "1500000000000000123",
      text: "After restart",
    }),
  ).toEqual(["1500000000000000999"]);
  await bridge.stop();
  store.close();
});
test("real upstream chunk loop resumes partial sends and suppresses broad mentions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "help-chunk-test-"));
  writeFileSync(
    join(dir, "access.json"),
    JSON.stringify({ ...accessFile(config), textChunkLimit: 10 }),
  );
  const store = new Store(join(dir, "help.db"));
  const outbox = new Outbox(store);
  const seen = new Map<string, string>();
  let attempted = 0;
  let interrupted = false;
  const bridge = new DiscordBridge("unused", getStatePaths(dir), {
    receive: async () => {},
    dmRecipient: () => undefined,
  });
  (bridge.client.channels as any).fetch = async () => ({
    id: event().channelId,
    type: 0,
    isTextBased: () => true,
    isThread: () => false,
    send: async (payload: any) => {
      expect(payload.allowedMentions).toEqual({
        parse: [],
        repliedUser: false,
      });
      expect(payload.enforceNonce).toBe(true);
      attempted++;
      const id =
        seen.get(payload.nonce) ||
        String(1500000000000000000n + BigInt(seen.size + 1));
      seen.set(payload.nonce, id);
      if (seen.size === 2 && !interrupted) {
        interrupted = true;
        throw new Error("accepted before disconnect");
      }
      return { id };
    },
  });
  const params = {
    chatId: event().channelId,
    text: "@everyone one two three four five six seven",
    deliverPart: (part: number, payload: any, send: any) =>
      outbox.part("chunks", part, "event", event().channelId, payload, send),
  };
  await expect(bridge.sendMessage(params)).rejects.toThrow();
  const ids = await bridge.sendMessage(params);
  expect(new Set(ids).size).toBe(ids.length);
  expect(seen.size).toBe(ids.length);
  expect(attempted).toBe(ids.length + 1);
  await bridge.stop();
  store.close();
});
test("history permission is checked before private message content is fetched", async () => {
  const store = new Store(fixture());
  store.receive(event(), "public");
  const job = store.claim()!;
  store.bindThread(job.conversation, "thread");
  let reads = 0;
  const bridge: any = {
    fetchAllowedChannel: async () => ({
      id: "1485880246711488524",
      isThread: () => false,
      messages: {
        fetch: async () => {
          reads++;
          return new Map();
        },
      },
    }),
  };
  const ops = new Operations(store, bridge, config, tmpdir());
  await expect(
    ops.call("thread", "fetch_messages", { channelId: "1485880246711488524" }),
  ).rejects.toThrow("outside this audience");
  expect(reads).toBe(0);
  await expect(ops.call("forged-thread", "context", {})).rejects.toThrow(
    "No active",
  );
  store.close();
});
test("catch-up pages beyond 100 messages and preserves cursor when coverage is incomplete", async () => {
  const store = new Store(fixture());
  store.advance(event().channelId, "1500000000000000000");
  let page = 0;
  const received: string[] = [];
  const bridge: any = {
    client: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => {
              const end = page++ === 0 ? 200 : 100;
              return new Map(
                Array.from({ length: 100 }, (_, i) => {
                  const id = String(1500000000000000000n + BigInt(end - i));
                  return [id, { id }];
                }),
              );
            },
          },
        }),
      },
    },
  };
  await expect(
    catchupChannel(
      bridge,
      store,
      event().channelId,
      async (m: any) => {
        received.push(m.id);
      },
      1,
    ),
  ).rejects.toThrow("limit reached");
  expect(store.cursor(event().channelId)).toBe("1500000000000000000");
  expect(received).toHaveLength(0);
  page = 0;
  bridge.client.channels.fetch = async () => ({
    isTextBased: () => true,
    messages: {
      fetch: async () => {
        const end = page++ === 0 ? 200 : page === 2 ? 100 : 0;
        return new Map(
          Array.from({ length: end === 0 ? 1 : 100 }, (_, i) => {
            const id = String(1500000000000000000n + BigInt(end - i));
            return [id, { id }];
          }),
        );
      },
    },
  });
  await catchupChannel(
    bridge,
    store,
    event().channelId,
    async (m: any) => {
      received.push(m.id);
    },
    3,
  );
  expect(received).toHaveLength(200);
  expect(received[0]).toBe("1500000000000000001");
  expect(store.cursor(event().channelId)).toBe("1500000000000000200");
  store.close();
});
test("read broker rejects secrets and path traversal before opening files", () => {
  const job = {
    event: event(),
    conversation: "room",
    attempts: 1,
    lease: "lease",
  };
  for (const path of [
    ".claude/settings.local.json",
    "worker/src/../../.claude/settings.local.json",
    "C:/Users/Jarid/.codex/auth.json",
    "worker/src/secrets.json",
  ])
    expect(() => readResource(config, job, "source", path)).toThrow();
});

test("installed skill reader opens instructions without exposing host files or escaped links", () => {
  const home = mkdtempSync(join(tmpdir(), "help-skill-test-"));
  mkdirSync(join(home, "skills", "discord-help"), { recursive: true });
  writeFileSync(
    join(home, "skills", "discord-help", "SKILL.md"),
    "Scoped HELP instructions",
  );
  const scoped = { ...config, codexHome: home };
  const job = {
    event: event(),
    conversation: "room",
    attempts: 1,
    lease: "lease",
  };
  expect(readResource(scoped, job, "skill", "discord-help").text).toBe(
    "Scoped HELP instructions",
  );
  for (const name of ["../auth", "C:/auth", "discord-help/SKILL.md"])
    expect(() => readResource(scoped, job, "skill", name)).toThrow(
      "Invalid skill name",
    );
  const outside = mkdtempSync(join(tmpdir(), "help-skill-outside-"));
  writeFileSync(join(outside, "SKILL.md"), "Private outside content");
  symlinkSync(outside, join(home, "skills", "escaped"), "junction");
  expect(() => readResource(scoped, job, "skill", "escaped")).toThrow(
    "escapes configured root",
  );
});

test("worker marks capability failure blocked and preserves partial delivery receipts", async () => {
  const state = mkdtempSync(join(tmpdir(), "help-operator-test-"));
  const store = new Store(join(state, "help.db"));
  store.receive(event(), "public");
  const job = store.claim()!;
  store.bindThread(job.conversation, "thread");
  const ops = new Operations(store, {} as any, config, state);
  store.prepare("partial", 0, job.event.id, job.event.channelId, {});
  store.sent("partial", 0, "1500000000000000999");
  const context = (await ops.call("thread", "context", {})) as any;
  expect(context.deliveries[0].message_id).toBe("1500000000000000999");
  const server = {
    request: async (method: string) =>
      method === "turn/start"
        ? { turn: { id: "turn" } }
        : { thread: { id: "thread" } },
    waitTurn: async () => {
      await ops.call("thread", "needs_operator", {
        reason: "Required collector unavailable",
      });
      return { status: "completed" };
    },
  };
  const worker = new Worker(
    store,
    server as any,
    config,
    state,
    "http://127.0.0.1",
    "fixture",
    (id) => ops.outcome(id),
  );
  await (worker as any).run(job);
  expect(store.status().attention).toHaveLength(1);
  expect(store.claim()).toBeUndefined();
  expect(ops.outcome(job.event.id)).toBe(
    "operator:Required collector unavailable",
  );
  store.close();
});

test("support-room template explicitly grants visibility and conversation access to the bot and participant", async () => {
  const state = mkdtempSync(join(tmpdir(), "help-support-test-"));
  const store = new Store(join(state, "help.db"));
  store.receive(event(), "public");
  const job = store.claim()!;
  store.bindThread(job.conversation, "thread");
  let created: any;
  const bridge: any = {
    client: {
      guilds: {
        fetch: async () => ({
          channels: {
            create: async (input: any) => {
              created = input;
              return { id: "1500000000000000777" };
            },
          },
        }),
      },
    },
  };
  const ops = new Operations(
    store,
    bridge,
    { ...config, channels: { ...config.channels } },
    state,
  );
  await ops.call("thread", "create_support", {
    key: "help",
    symptom: "Fixture",
  });
  expect(
    created.permissionOverwrites.find((p: any) => p.id === config.guildId).deny,
  ).toContain(PermissionFlagsBits.ViewChannel);
  for (const id of [config.botApplicationId, job.event.userId]) {
    const allowed = created.permissionOverwrites.find(
      (p: any) => p.id === id,
    ).allow;
    for (const bit of [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ])
      expect(allowed).toContain(bit);
    expect(allowed).not.toContain(PermissionFlagsBits.ManageWebhooks);
    expect(allowed).not.toContain(PermissionFlagsBits.ManageRoles);
  }
  store.close();
});

test("native error notifications do not crash the listener or finish a retrying turn", async () => {
  const server = new AppServer("unused", "unused", "unused");
  let finished = false;
  const result = server.waitTurn("turn", 1000).then((value) => {
    finished = true;
    return value;
  });
  expect(() =>
    (server as any).notification("error", {
      turnId: "turn",
      willRetry: true,
      error: { message: "Transient connection failure" },
    }),
  ).not.toThrow();
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(() =>
    (server as any).notification("error", {
      turnId: "turn",
      willRetry: false,
      error: { codexErrorInfo: "usageLimitExceeded" },
    }),
  ).not.toThrow();
  (server as any).notification("turn/completed", {
    turn: {
      id: "turn",
      status: "failed",
      error: {
        codexErrorInfo: "usageLimitExceeded",
        message: "Usage reset required",
      },
    },
  });
  expect((await result).error.codexErrorInfo).toBe("usageLimitExceeded");
  expect((await server.waitTurn("turn")).status).toBe("failed");
});

test("usage exhaustion blocks the event without a supervisor crash or automatic replay", async () => {
  const state = mkdtempSync(join(tmpdir(), "help-usage-test-"));
  const store = new Store(join(state, "help.db"));
  store.receive(event(), "public");
  const job = store.claim()!;
  const failure = {
    status: "failed",
    error: { codexErrorInfo: "usageLimitExceeded", message: "Wait for reset" },
  };
  const server = {
    request: async (method: string) =>
      method === "turn/start"
        ? { turn: { id: "turn" } }
        : { thread: { id: "thread" } },
    waitTurn: async () => failure,
  };
  const worker = new Worker(
    store,
    server as any,
    config,
    state,
    "http://127.0.0.1",
    "fixture",
    () => undefined,
  );
  await (worker as any).run(job);
  expect(store.status().attention).toHaveLength(1);
  expect(store.claim(Date.now() + 999999)).toBeUndefined();
  expect(
    (
      store.db
        .query("SELECT error FROM inbox WHERE id=?")
        .get(job.event.id) as any
    ).error,
  ).toContain("Codex usage limit");
  store.close();
});

test("worker memory capabilities match its embedding configuration", () => {
  const enabled = workerConfig(
    "home",
    "private-room",
    "orch",
    "http://127.0.0.1",
    "fixture",
    "bun",
  ).mcp_servers.orchestrator;
  expect(enabled.env.ORCHESTRATOR_EMBEDDINGS).toBe("on");
  expect(enabled.enabled_tools).toContain("check_similar");
  const disabled = workerConfig(
    "home",
    "private-room",
    "orch",
    "http://127.0.0.1",
    "fixture",
    "bun",
    false,
  ).mcp_servers.orchestrator;
  expect(disabled.env.ORCHESTRATOR_EMBEDDINGS).toBe("off");
  expect(disabled.enabled_tools).not.toContain("check_similar");
  expect(disabled.enabled_tools).toContain("lookup");
  expect(enabled.env.ORCHESTRATOR_PROJECT_ROOT).toBe("private-room");
});

test("shared project knowledge is read-only while room memory retains maintenance tools", () => {
  const servers = workerConfig("home", "private-room", "orch", "http://127.0.0.1", "fixture", "bun", true, "shared-project").mcp_servers;
  expect(servers.project_knowledge!.env.ORCHESTRATOR_PROJECT_ROOT).toBe("shared-project");
  expect(servers.orchestrator.env.ORCHESTRATOR_PROJECT_ROOT).toBe("private-room");
  expect(servers.orchestrator.enabled_tools).toContain("update_note");
  expect(guard({tool_name: "mcp__orchestrator__update_note"})).toEqual({});
  expect(guard({tool_name: "mcp__project_knowledge__lookup"})).toEqual({});
  for (const tool of ["note", "update_note", "delete_note", "install_embeddings", "save_progress"]) {
    expect(servers.project_knowledge!.enabled_tools).not.toContain(tool);
    expect(guard({tool_name: `mcp__project_knowledge__${tool}`}).hookSpecificOutput?.permissionDecision).toBe("deny");
  }
  const offline = workerConfig("home", "room", "orch", "http://127.0.0.1", "fixture", "bun", false, "shared").mcp_servers;
  expect(offline.project_knowledge!.enabled_tools).not.toContain("check_similar");
});
