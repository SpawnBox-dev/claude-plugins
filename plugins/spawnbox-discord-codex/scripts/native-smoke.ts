// Deterministic Responses fixture: real Codex, hooks, MCP and worker queue;
// no model inference, Discord login, user credentials or public messages.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { Store } from "../src/store";
import { Worker } from "../src/worker";
import { AppServer } from "../src/app-server";
import { Operations } from "../src/operations";
import { setupWorker } from "../src/setup";
import { validateOperation } from "../src/mcp";
import type { HelpConfig, Inbound } from "../src/types";

const root = resolve(import.meta.dir, "..");
const fixture = mkdtempSync(join(tmpdir(), "help-codex-native-"));
const state = join(fixture, "state"),
  home = join(fixture, "home");
mkdirSync(state);
mkdirSync(home);
const config: HelpConfig = {
  schemaVersion: 1,
  projectRoot: fixture,
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
  },
  diagnosticWebhooks: {},
  model: "gpt-5.4",
  codexExecutable: process.env.CODEX_EXECUTABLE || "codex",
  codexHome: home,
  orchestratorRoot: resolve(root, "../orchestrator-codex"),
  maxConcurrency: 1,
  memoryEmbeddings: false,
  projectKnowledge: true,
  catchupPageLimit: 2,
};
config.model = process.env.HELP_TEST_MODEL || "gpt-6-astra";
await setupWorker(config, root);
let store = new Store(join(state, "help.db"));
const sent: string[] = [];
const bridge: any = {
  sendMessage: async (params: any) => [
    await params.deliverPart(0, { content: params.text }, async () => {
      sent.push(params.text);
      return "1500000000000000099";
    }),
  ],
};
let operations = new Operations(store, bridge, config, state);
const endpoint = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as any;
    try {
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
let count = 0;
let sharedNoteId = "";
function sharedFixtureNote() {
  const db = new Database(join(fixture, ".orchestrator", "project.db"), { readonly: true });
  try { return db.query("SELECT id,content,source_session FROM notes WHERE content LIKE 'HELP_SHARED_CRUD%'").get() as any; }
  finally { db.close(); }
}
const search = (n: number, query: string) => ({
  type: "tool_search_call",
  id: `tool-${n}`,
  call_id: `call-${n}`,
  execution: "client",
  status: "completed",
  arguments: { query, limit: 1 },
});
const call = (n: number, namespace: string, name: string, args: unknown) => ({
  type: "function_call",
  id: `tool-${n}`,
  call_id: `call-${n}`,
  namespace,
  name,
  arguments: JSON.stringify(args),
});
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as any;
    const n = count++;
    writeFileSync(
      join(fixture, `request-${n}.json`),
      JSON.stringify(body, null, 2),
    );
    let item: any;
    if (n === 0 || n === 8) item = search(n, "spawnbox_discord context");
    else if (n === 1 || n === 9)
      item = call(n, "mcp__spawnbox_discord", "context", {});
    else if (n === 2) item = search(n, "spawnbox_discord reply");
    else if (n === 3)
      item = call(n, "mcp__spawnbox_discord", "reply", {
        key: "answer",
        text: "Fixture received your message.",
      });
    else if (n === 4)
      item = {
        type: "custom_tool_call",
        id: `tool-${n}`,
        call_id: `call-${n}`,
        name: "apply_patch",
        input: `*** Begin Patch\n*** Add File: forbidden.txt\n+MUST NOT EXIST\n*** End Patch`,
      };
    else if (n === 5 || n === 12)
      item = search(n, "orchestrator save_progress");
    else if (n === 6 || n === 13)
      item = call(n, "mcp__orchestrator", "save_progress", {
        summary: "HELP_NATIVE_CHECKPOINT",
        next_steps: ["Wait for inbound event"],
      });
    else if (n === 10) item = search(n, "spawnbox_discord no_reply");
    else if (n === 11)
      item = call(n, "mcp__spawnbox_discord", "no_reply", {
        reason: "Conversation already answered; follow-up acknowledged locally",
      });
    else if (n === 14) item = search(n, "spawnbox_discord read_resource");
    else if (n === 15)
      item = call(n, "mcp__spawnbox_discord", "read_resource", {
        kind: "skill",
        name: "discord-help",
      });
    else if (n === 16)
      item = call(n, "mcp__spawnbox_discord", "read_resource", {
        kind: "skill", name: "discord-bootstrap",
      });
    else if (n === 17) item = search(n, "project_knowledge system_status");
    else if (n === 18)
      item = call(n, "mcp__project_knowledge", "system_status", {});
    else if (n === 19) item = search(n, "project_knowledge note");
    else if (n === 20)
      item = call(n, "mcp__project_knowledge", "note", {
        type: "insight", scope: "project", content: "HELP_SHARED_CRUD initial fixture evidence",
        context: "Synthetic native test; no Discord participant or production evidence",
      });
    else if (n === 21) {
      const saved = sharedFixtureNote();
      assert(saved, "Shared note was not persisted");
      sharedNoteId = saved.id;
      assert(saved.source_session?.startsWith("codex-"), "Shared mutation lost native attribution");
      item = search(n, "project_knowledge lookup");
    } else if (n === 22 || n === 25 || n === 28)
      item = call(n, "mcp__project_knowledge", "lookup", { id: sharedNoteId, include_history: true });
    else if (n === 23) item = search(n, "project_knowledge update_note");
    else if (n === 24)
      item = call(n, "mcp__project_knowledge", "update_note", { id: sharedNoteId, content: "HELP_SHARED_CRUD corrected fixture evidence" });
    else if (n === 26) {
      assert.equal(sharedFixtureNote()?.content, "HELP_SHARED_CRUD corrected fixture evidence");
      assert(JSON.stringify(body).includes("initial fixture evidence"), "Revision history was not available");
      item = search(n, "project_knowledge delete_note");
    } else if (n === 27)
      item = call(n, "mcp__project_knowledge", "delete_note", { id: sharedNoteId, reason: "Remove synthetic CRUD acceptance note" });
    else
      item = {
        type: "message",
        id: `message-${n}`,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Private final: never forward this to Discord.",
            annotations: [],
          },
        ],
      };
    const response = {
      id: `response-${n}`,
      object: "response",
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const evt = (type: string, data: unknown) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
    return new Response(
      evt("response.created", {
        response: { ...response, status: "in_progress", output: [] },
      }) +
        evt("response.output_item.added", { output_index: 0, item }) +
        evt("response.output_item.done", { output_index: 0, item }) +
        evt("response.completed", { response }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
let app = new AppServer(config.codexExecutable, home, state);
let worker: Worker | undefined;
const events: any[] = [];
let logs = "";
app.on("diagnostic", (text) => {
  logs += text;
});
app.on("hook/completed", (event) => events.push(event));
try {
  await app.start();
  const overrides = {
    model_provider: "fixture",
    model_providers: {
      fixture: {
        name: "Deterministic HELP fixture",
        base_url: `http://127.0.0.1:${model.port}/v1`,
        wire_api: "responses",
        requires_openai_auth: false,
      },
    },
  };
  worker = new Worker(
    store,
    app,
    config,
    state,
    `http://127.0.0.1:${endpoint.port}`,
    "fixture",
    (id) => operations.outcome(id),
    overrides,
  );
  const event: Inbound = {
    id: "1500000000000000001",
    channelId: "1471275386355847302",
    guildId: config.guildId,
    userId: config.ownerIds[0],
    username: "fixture",
    content: "Help me",
    timestamp: new Date().toISOString(),
    isDM: false,
    attachments: [],
    embeds: [],
  };
  store.receive(event, "public");
  worker.start();
  const waitHandled = async (id: string) => {
    const deadline = Date.now() + 45000;
    for (;;) {
      const row = store.db
        .query("SELECT state,error FROM inbox WHERE id=?")
        .get(id) as any;
      if (row.state === "handled") return;
      if (Date.now() > deadline || row.state === "blocked")
        throw new Error(
          `Worker did not handle event: ${JSON.stringify(row)}; fixture=${fixture}`,
        );
      await Bun.sleep(100);
    }
  };
  await waitHandled(event.id);
  assert.equal(sent.length, 1);
  assert.equal(count, 8, `Unexpected response steps: ${count}`);
  const thread = (
    store.db.query("SELECT thread_id FROM conversations").get() as any
  ).thread_id;
  await worker.stop();
  await app.stop();
  store.close();
  store = new Store(join(state, "help.db"));
  operations = new Operations(store, bridge, config, state);
  app = new AppServer(config.codexExecutable, home, state);
  app.on("diagnostic", (text) => {
    logs += text;
  });
  app.on("hook/completed", (event) => events.push(event));
  await app.start();
  worker = new Worker(
    store,
    app,
    config,
    state,
    `http://127.0.0.1:${endpoint.port}`,
    "fixture",
    (id) => operations.outcome(id),
    overrides,
  );
  store.receive(
    { ...event, id: "1500000000000000002", content: "Thanks" },
    "public",
  );
  worker.start();
  await waitHandled("1500000000000000002");
  assert.equal(count, 30);
  assert.equal(sharedFixtureNote(), null, "Synthetic note was not deleted");
  assert(
    (await Bun.file(join(fixture, "request-16.json")).text()).includes(
      "Apply these",
    ),
    "Installed skill contents did not reach the native model",
  );
  assert((await Bun.file(join(fixture, "request-17.json")).text()).includes("canonical persona policy"), "Bootstrap instructions did not reach native model");
  assert((await Bun.file(join(fixture, "request-19.json")).text()).includes("knowledge_root"), "Shared KB status did not reach native model");
  assert.equal(
    (store.db.query("SELECT thread_id FROM conversations").get() as any)
      .thread_id,
    thread,
    "Follow-up started a new conversation",
  );
  assert.equal(
    sent.length,
    1,
    "Final output or silent follow-up was incorrectly sent",
  );
  for (const dir of readdirSync(join(state, "conversations")))
    assert(
      !existsSync(join(state, "conversations", dir, "forbidden.txt")),
      "Native patch bypassed HELP guard",
    );
  assert(
    events.some((event) =>
      JSON.stringify(event).includes("HELP conversations use only"),
    ),
    "No native guard evidence",
  );
  console.log(
    JSON.stringify({
      ok: true,
      fixture,
      inboundWake: true,
      threadContinuity: true,
      processRestart: true,
      explicitReplyOnly: true,
      noReply: true,
      nativePatchBlocked: true,
      sharedKnowledgeCRUD: true,
      responses: count,
    }),
  );
} finally {
  await app.stop();
  await worker?.stop();
  store.close();
  model.stop(true);
  endpoint.stop(true);
  writeFileSync(join(fixture, "stderr.log"), logs);
  writeFileSync(join(fixture, "hooks.json"), JSON.stringify(events, null, 2));
}
