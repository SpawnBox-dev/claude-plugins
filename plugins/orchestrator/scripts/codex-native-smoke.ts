// Exercises the installed Codex host without delegating work to another model.
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";

const executable = process.env.CODEX_EXECUTABLE || "codex";
const fixture = mkdtempSync(join(tmpdir(), "orchestrator-codex-native-"));
const project = join(fixture, "project");
const home = join(fixture, "home");
mkdirSync(project); mkdirSync(home);
const env: NodeJS.ProcessEnv = { ...process.env, RUST_LOG: "info", CODEX_HOME: home, ORCHESTRATOR_PROJECT_ROOT: project, ORCHESTRATOR_GLOBAL_DB: join(fixture, "global.db"), ORCHESTRATOR_EMBEDDINGS: "off" };
delete env.CODEX_THREAD_ID;
const repo = resolve(import.meta.dir, "../../..");
for (const args of [["plugin", "marketplace", "add", repo, "--json"], ["plugin", "add", "orchestrator-codex@spawnbox-dev-codex-plugins", "--json"]]) {
  execFileSync(executable, args, { env, cwd: project, windowsHide: true, stdio: "pipe" });
}
const child = spawn(executable, ["app-server"], { env, cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk.toString(); });
const lines = createInterface({ input: child.stdout });
const events: unknown[] = [];
lines.on("line", line => {
  const message = JSON.parse(line);
  const call = pending.get(message.id);
  if (call) { clearTimeout(call.timer); pending.delete(message.id); message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result); }
  else if (message.method) events.push(message);
});
const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 45000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
let responseIndex = 0;
// A deterministic Responses fixture exercises native turns without an LLM or
// credentials. Codex still executes the actual tools, hooks and Stop continuation.
const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const body = await req.json() as any;
  writeFileSync(join(fixture, `model-request-${responseIndex}.json`), JSON.stringify(body, null, 2));
  const n = responseIndex++;
  const id = `response-${n}`;
  if (new URL(req.url).pathname.endsWith("/compact")) return Response.json({ id, object: "response.compaction", created_at: Math.floor(Date.now()/1000), output: [{ type: "compaction", encrypted_content: "deterministic-fixture-compaction" }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  const tools = [...body.tools || [], ...(body.input || []).filter((item: any) => item.type === "tool_search_output").flatMap((item: any) => item.tools || [])].flatMap((tool: any) => tool.type === "namespace" ? tool.tools.map((nested: any) => ({ ...nested, namespace: tool.name })) : [tool]);
  let item: any;
  if (n === 0) {
    const tool = tools.find((tool: any) => tool.name === "apply_patch");
    if (!tool) return new Response(JSON.stringify({ error: { message: "Native apply_patch missing", type: "fixture_error" } }), { status: 400 });
    const patch = "*** Begin Patch\n*** Add File: native-fixture.txt\n+Native hook fixture\n*** End Patch";
    item = tool.type === "custom" ? { type: "custom_tool_call", id: `tool-${n}`, call_id: `call-${n}`, name: tool.name, input: patch } : { type: "function_call", id: `tool-${n}`, call_id: `call-${n}`, name: tool.name, arguments: JSON.stringify({ patch }) };
  } else if (n === 2) {
    item = { type: "tool_search_call", id: `tool-${n}`, call_id: `call-${n}`, execution: "client", status: "completed", arguments: { query: "orchestrator save_progress", limit: 1 } };
  } else if (n === 3) {
    const tool = tools.find((tool: any) => (tool.name === "save_progress" && tool.namespace === "mcp__orchestrator") || tool.name === "mcp__orchestrator__save_progress");
    if (!tool) return new Response(JSON.stringify({ error: { message: "Native checkpoint discovery failed", type: "fixture_error" } }), { status: 400 });
    item = { type: "function_call", id: `tool-${n}`, call_id: `call-${n}`, namespace: tool.namespace, name: tool.name, arguments: JSON.stringify({ summary: "Native edit verified", next_steps: ["Resume fixture"] }) };
  } else item = { type: "message", id: `message-${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Native fixture complete.", annotations: [] }] };
  const response = { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`;
  return new Response(event("response.created", { response: { ...response, status: "in_progress", output: [] } }) + event("response.output_item.added", { output_index: 0, item }) + event("response.output_item.done", { output_index: 0, item }) + event("response.completed", { response }), { headers: { "content-type": "text/event-stream" } });
} });
try {
  await request("initialize", { clientInfo: { name: "orchestrator_native_fixture", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const inventory = await request("hooks/list", { cwds: [project] });
  const hooks = inventory.data.flatMap((entry: any) => entry.hooks).filter((hook: any) => hook.pluginId === "orchestrator-codex@spawnbox-dev-codex-plugins");
  assert.equal(hooks.length, 7, JSON.stringify(inventory));
  assert(hooks.every((hook: any) => hook.handlerType === "command" && hook.command.includes("orchestrator-codex") && hook.command.endsWith('/dist/hook.js"')));
  // Trust only this fixture's reviewed plugin hooks, through the same API as /hooks.
  await request("config/batchWrite", { edits: [{ keyPath: "hooks.state", value: Object.fromEntries(hooks.map((hook: any) => [hook.key, { trusted_hash: hook.currentHash }])), mergeStrategy: "upsert" }], reloadUserConfig: true });
  const config = { mcp_servers: { context_probe: { command: process.execPath, args: [join(import.meta.dir, "codex-context-probe.ts")] } } };
  const start = await request("thread/start", { cwd: project, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", config });
  const threadId = start.thread.id;
  const status = await request("mcpServerStatus/list", { threadId });
  writeFileSync(join(fixture, "inventory.json"), JSON.stringify(status, null, 2));
  console.log(JSON.stringify({ fixture, threadId, servers: status.data?.map((server: any) => ({ name: server.name, status: server.status, error: server.error })) }));
  const probe = await request("mcpServer/tool/call", { threadId, server: "context_probe", tool: "inspect_context", arguments: {} });
  console.log(JSON.stringify({ probe }));
  const core = status.data.find((server: any) => server.name === "orchestrator");
  assert(core, "Installed plugin MCP was not loaded");
  const runtime = await request("mcpServer/tool/call", { threadId, server: core.name, tool: "system_status", arguments: {} });
  console.log(JSON.stringify({ runtime }));
  assert(JSON.stringify(runtime).includes(`codex-${threadId}`), "Host identity did not bind to the current task");
  const progress = await request("mcpServer/tool/call", { threadId, server: core.name, tool: "save_progress", arguments: { summary: "NATIVE_CHECKPOINT_SENTINEL", next_steps: ["Verify scoped recovery"] } });
  assert(!progress.isError, JSON.stringify(progress));
  const briefing = await request("mcpServer/tool/call", { threadId, server: core.name, tool: "briefing", arguments: { sections: ["checkpoint"], event: "resume" } });
  assert(JSON.stringify(briefing).includes("NATIVE_CHECKPOINT_SENTINEL"));
  const second = await request("thread/start", { cwd: project, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", config });
  const other = await request("mcpServer/tool/call", { threadId: second.thread.id, server: core.name, tool: "briefing", arguments: { sections: ["checkpoint"], event: "resume" } });
  assert(!JSON.stringify(other).includes("NATIVE_CHECKPOINT_SENTINEL"), "Checkpoint leaked across tasks");
  console.log(JSON.stringify({ ok: true, hooks: hooks.length, checkpointIsolation: true }));
  const lifecycle = await request("thread/start", { cwd: project, ephemeral: false, approvalPolicy: "never", sandbox: "danger-full-access", model: "gpt-5.4", config: { ...config, model_provider: "fixture", model_providers: { fixture: { name: "Deterministic integration fixture", base_url: `http://127.0.0.1:${model.port}/v1`, wire_api: "responses", requires_openai_auth: false } } } });
  const lifecycleId = lifecycle.thread.id;
  await request("mcpServer/tool/call", { threadId: lifecycleId, server: "orchestrator", tool: "note", arguments: { type: "convention", content: "NATIVE_FILE_CONTEXT: keep fixture output deterministic", code_refs: ["native-fixture.txt"] } });
  await request("turn/start", { threadId: lifecycleId, input: [{ type: "text", text: "Exercise the native fixture.", text_elements: [] }] });
  const deadline = Date.now() + 30000;
  while (!events.some((event: any) => event.method === "turn/completed" && event.params.threadId === lifecycleId)) {
    if (Date.now() > deadline) throw new Error("Native turn did not complete");
    await Bun.sleep(50);
  }
  const completed = [...events].reverse().find((event: any) => event.method === "turn/completed" && event.params.threadId === lifecycleId) as any;
  assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed));
  assert(events.some((event: any) => event.method === "hook/completed" && event.params.threadId === lifecycleId && event.params.run.eventName === "preToolUse" && JSON.stringify(event.params.run.entries).includes("NATIVE_FILE_CONTEXT")), "Prior file knowledge was not surfaced before the edit");
  const db = new Database(join(project, ".orchestrator/project.db"), { readonly: true });
  const delivered = db.query("SELECT key,value FROM plugin_state WHERE key LIKE ?").all(`codex_hook_%_codex-${lifecycleId}`) as { key: string; value: string }[];
  assert(db.query("SELECT 1 FROM notes WHERE type='checkpoint' AND source_session=? AND content LIKE '%Native edit verified%'").get(`codex-${lifecycleId}`), "Native checkpoint tool did not run");
  db.close();
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) assert(delivered.some(row => row.key.includes(`hook_${event}_`)), `${event} was not delivered: ${JSON.stringify(delivered)}`);
  assert(responseIndex >= 4, "Stop did not cause the checkpoint continuation");
  console.log(JSON.stringify({ lifecycle: true, responses: responseIndex, events: delivered.map(row => row.key.split("_codex-")[0]) }));
  await request("thread/compact/start", { threadId: lifecycleId });
  const compactDeadline = Date.now() + 15000;
  while (!events.some((event: any) => event.method === "item/completed" && event.params.threadId === lifecycleId && event.params.item.type === "contextCompaction")) {
    if (Date.now() > compactDeadline) throw new Error("Native compaction did not complete");
    await Bun.sleep(50);
  }
  const compactDb = new Database(join(project, ".orchestrator/project.db"), { readonly: true });
  assert(compactDb.query("SELECT 1 FROM plugin_state WHERE key=?").get(`codex_hook_PreCompact_codex-${lifecycleId}`), "PreCompact did not execute");
  compactDb.close();
  const continuation = await request("turn/start", { threadId: lifecycleId, input: [{ type: "text", text: "Continue after compaction.", text_elements: [] }] });
  const continuationDeadline = Date.now() + 15000;
  while (!events.some((event: any) => event.method === "turn/completed" && event.params.turn.id === continuation.turn.id)) {
    if (Date.now() > continuationDeadline) throw new Error("Postcompact continuation did not complete");
    await Bun.sleep(50);
  }
  assert(events.some((event: any) => event.method === "hook/completed" && event.params.turnId === continuation.turn.id && event.params.run.eventName === "sessionStart" && JSON.stringify(event.params.run.entries).includes("Native edit verified")), "Postcompact hook did not restore the task checkpoint");
  console.log(JSON.stringify({ compact: true }));
  await request("thread/archive", { threadId: lifecycleId });
  const endDb = new Database(join(project, ".orchestrator/project.db"), { readonly: true });
  assert(endDb.query("SELECT 1 FROM plugin_state WHERE key=?").get(`codex_hook_SessionEnd_codex-${lifecycleId}`), "SessionEnd did not execute");
  endDb.close();
  await request("thread/unarchive", { threadId: lifecycleId });
  await request("thread/resume", { threadId: lifecycleId, cwd: project, config: { ...config, model_providers: { fixture: { name: "Deterministic integration fixture", base_url: `http://127.0.0.1:${model.port}/v1`, wire_api: "responses", requires_openai_auth: false } } } });
  const recovery = await request("mcpServer/tool/call", { threadId: lifecycleId, server: "orchestrator", tool: "briefing", arguments: { sections: ["checkpoint"], event: "resume" } });
  assert(JSON.stringify(recovery).includes("Native edit verified"), "Native resume lost the checkpoint");
  await request("thread/archive", { threadId: lifecycleId });
  console.log(JSON.stringify({ resume: true, sessionEnd: true }));
  writeFileSync(join(fixture, "events.json"), JSON.stringify(events, null, 2));
} finally {
  for (const call of pending.values()) clearTimeout(call.timer);
  child.stdin.end();
  await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), Bun.sleep(1000)]);
  if (child.exitCode === null) child.kill();
  lines.close(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
  writeFileSync(join(fixture, "stderr.log"), stderr);
  writeFileSync(join(fixture, "events.json"), JSON.stringify(events, null, 2));
  model.stop(true);
}
