import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import type { Message } from "discord.js";
import { DiscordBridge } from "../vendor/codex-discord-mcp/src/discord";
import { getStatePaths } from "../vendor/codex-discord-mcp/src/state";
import { Store } from "./store";
import { AppServer } from "./app-server";
import { Worker } from "./worker";
import { Operations } from "./operations";
import { accessFile, admit, envelope } from "./policy";
import { validateOperation } from "./mcp";
import type { HelpConfig } from "./types";

export async function catchupChannel(
  bridge: DiscordBridge,
  store: Store,
  channelId: string,
  receive: (m: Message) => Promise<void>,
  maxPages: number,
) {
  const channel = await bridge.client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !("messages" in channel)) return;
  const cursor = store.cursor(channelId);
  let before: string | undefined;
  const found: Message[] = [];
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    const rows = [...messages.values()];
    for (const message of rows)
      if (!cursor || BigInt(message.id) > BigInt(cursor)) found.push(message);
    if (
      rows.length < 100 ||
      (cursor && rows.some((m) => BigInt(m.id) <= BigInt(cursor)))
    ) {
      complete = true;
      break;
    }
    before = rows.at(-1)?.id;
  }
  if (!complete)
    throw new Error(
      `Catch-up limit reached for ${channelId}; coverage cursor retained. Increase limit or explicitly seed a starting cursor.`,
    );
  found.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  for (const message of found) await receive(message);
  if (found.length) store.advance(channelId, found.at(-1)!.id);
}
export async function startService(
  config: HelpConfig,
  state: string,
  token: string,
) {
  mkdirSync(state, { recursive: true });
  const store = new Store(join(state, "help.db"));
  const owner = randomUUID();
  if (!store.lock("gateway", owner))
    throw new Error("A HELP service already owns this state directory");
  const lease = setInterval(() => {
    if (!store.lock("gateway", owner)) {
      store.audit("fatal", "Lost gateway lock");
      void stop();
    }
  }, 10000);
  for (const row of store.db
    .query("SELECT id,audience FROM dynamic_channels")
    .all() as any[])
    config.channels[row.id] = {
      audience: row.audience,
      requireMention: false,
      allowUsers: [],
    };
  writeFileSync(
    join(state, "access.json"),
    JSON.stringify(accessFile(config), null, 2),
  );
  const clientToken = randomBytes(32).toString("hex");
  let bridge: DiscordBridge;
  let worker: Worker | undefined;
  let app: AppServer | undefined;
  let stopping = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let identityVerified = false;
  let activated = false;
  const receive = async (message: Message) => {
    if (!identityVerified) return;
    const event = envelope(message);
    if (event.isDM && !config.dmAllowUsers.includes(event.userId)) return;
    let mentioned = message.mentions.users.has(bridge.client.user!.id);
    if (!mentioned && message.reference?.messageId) {
      const original = await message.fetchReference().catch(() => undefined);
      mentioned = original?.author.id === bridge.client.user!.id;
    }
    const audience = admit(
      config,
      event,
      message.author.bot,
      bridge.client.user!.id,
      mentioned,
    );
    if (audience && store.receive(event, audience) && activated) worker?.pump();
    if (
      activated &&
      (config.channels[event.parentId || event.channelId] ||
        store.dmUser(event.channelId))
    )
      store.advance(event.channelId, event.id);
  };
  bridge = new DiscordBridge(token, getStatePaths(state), {
    receive,
    dmRecipient: (channel) => store.dmUser(channel),
  });
  bridge.on("ingressError", (error) =>
    store.audit("ingress_error", String(error)),
  );
  const operations = new Operations(store, bridge, config, state);
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 128 * 1024,
    async fetch(req) {
      const provided = Buffer.from(req.headers.get("authorization") || "");
      const expected = Buffer.from(`Bearer ${clientToken}`);
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      )
        return new Response("Unauthorized", { status: 401 });
      if (new URL(req.url).pathname !== "/operation" || req.method !== "POST")
        return new Response("Not found", { status: 404 });
      try {
        const body = (await req.json()) as any;
        if (typeof body.threadId !== "string")
          throw new Error("Task identity required");
        return Response.json(
          await operations.call(
            body.threadId,
            body.tool,
            validateOperation(body.tool, body.args),
          ),
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    },
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(lease);
    await bridge.stop();
    await app?.stop();
    await worker?.stop();
    http.stop(true);
    store.unlock("gateway", owner);
    store.close();
    resolveClosed();
  };
  try {
    app = new AppServer(config.codexExecutable, config.codexHome, state);
    await app.start();
    const hookInventory = await app.request("hooks/list", { cwds: [state] });
    const guardHooks = hookInventory.data
      .flatMap((entry: any) => entry.hooks)
      .filter((hook: any) => hook.command?.includes("help-guard.js"));
    if (guardHooks.length !== 1 || guardHooks[0].trustStatus !== "trusted")
      throw new Error(
        "Dedicated HELP guard must be installed and explicitly trusted before service startup",
      );
    const memoryHooks = hookInventory.data
      .flatMap((entry: any) => entry.hooks)
      .filter((hook: any) => hook.command?.includes("memory-hook.js"));
    if (memoryHooks.length !== 7 || memoryHooks.some((hook: any) => hook.trustStatus !== "trusted"))
      throw new Error("All seven Orchestrator lifecycle hooks must be installed and trusted before HELP startup");
    worker = new Worker(
      store,
      app,
      config,
      state,
      `http://127.0.0.1:${http.port}`,
      clientToken,
      (id) => operations.outcome(id),
      {},
      (job) => operations.validateReview(job),
    );
    app.on("disconnected", (error) => {
      if (!stopping) {
        store.audit("fatal", String(error));
        void stop();
      }
    });
    const ready = once(bridge.client, "clientReady");
    await bridge.start();
    await Promise.race([
      ready,
      Bun.sleep(30000).then(() => {
        throw new Error("Discord readiness timed out");
      }),
    ]);
    if (bridge.client.user?.id !== config.botApplicationId)
      throw new Error(
        "Token belongs to a different bot application; refusing HELP startup",
      );
    identityVerified = true;
    // No application command registration: Worker-owned interactions survive.
    const scan = async () => {
      const guild = await bridge.client.guilds.fetch(config.guildId);
      const active = await guild.channels.fetchActiveThreads();
      const destinations = new Set([
        ...Object.keys(config.channels),
        ...active.threads
          .filter((t) => !!config.channels[t.parentId || ""])
          .map((t) => t.id),
        ...store.dmChannels(config.dmAllowUsers),
      ]);
      // Archived forum posts also contain conversations missed while offline.
      for (const id of Object.keys(config.channels)) {
        const parent = await bridge.client.channels.fetch(id);
        if (!parent || parent.type !== 15) continue;
        let before: Date | undefined;
        for (let page = 0; page < config.catchupPageLimit; page++) {
          const archived = await parent.threads.fetchArchived({
            limit: 100,
            ...(before ? { before } : {}),
          });
          for (const thread of archived.threads.values())
            destinations.add(thread.id);
          if (!archived.hasMore) break;
          const last = archived.threads.last();
          if (!last?.archiveTimestamp) break;
          before = new Date(last.archiveTimestamp);
          if (page === config.catchupPageLimit - 1)
            store.audit(
              "catchup_attention",
              `Archived thread enumeration limit reached for ${id}`,
            );
        }
      }
      for (const channel of destinations) {
        // A new listener takes responsibility from its first start, rather than
        // generating replies to every historical guild message. Existing history
        // remains available through paginated tools. Later starts use coverage.
        if (!store.cursor(channel)) {
          const floor = (
            (BigInt(Date.now()) - 1420070400000n) <<
            22n
          ).toString();
          store.advance(channel, floor);
          store.audit("initial_coverage", { channel, after: floor });
        }
        await catchupChannel(
          bridge,
          store,
          channel,
          receive,
          config.catchupPageLimit,
        ).catch((error) => store.audit("catchup_attention", String(error)));
      }
    };
    await scan();
    bridge.client.on("shardDisconnect", () => {
      activated = false;
    });
    const rescan = () => {
      activated = false;
      void scan()
        .catch((error) => store.audit("catchup_attention", String(error)))
        .finally(() => {
          activated = true;
          worker?.pump();
        });
    };
    bridge.client.on("shardResume", rescan);
    bridge.client.on("shardReady", rescan);
    activated = true;
    worker.start();
    store.audit("started", {
      application: config.botApplicationId,
      pid: process.pid,
    });
    return { stop, closed, status: () => store.status() };
  } catch (error) {
    await stop();
    throw error;
  }
}
