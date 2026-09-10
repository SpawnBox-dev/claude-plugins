import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";

const fixture = mkdtempSync(join(tmpdir(), "orchestrator-codex-protocol-"));
const project = join(fixture, "project");
mkdirSync(project);
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.CODEX_THREAD_ID;
Object.assign(env, { ORCHESTRATOR_HOST: "codex", ORCHESTRATOR_MODE: "standalone", ORCHESTRATOR_EMBEDDINGS: "off", ORCHESTRATOR_PROJECT_ROOT: project, ORCHESTRATOR_GLOBAL_DB: join(fixture, "global.db"), CODEX_HOME: join(fixture, "home"), CLAUDE_CODE_SESSION_ID: "unrelated-claude-id", ORCHESTRATOR_PA_PERMISSION_RELAY: "1" });
const client = new Client({ name: "orchestrator-codex-smoke", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dir, "../../orchestrator-codex/dist/server.js")], env, cwd: project, stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
try {
  await client.connect(transport);
  assert(!JSON.stringify(client.getServerCapabilities()).includes("claude/channel"));
  const tools = await client.listTools();
  assert(tools.tools.some(t => t.name === "save_progress"));
  assert(!tools.tools.some(t => /permission|_hook/.test(t.name)));
  const unbound = await client.callTool({ name: "note", arguments: { type: "insight", content: "Unbound mutation must fail" } });
  assert.equal(unbound.isError, true);
  const call = (name: string, args: Record<string, unknown>, thread = "protocol-task-one") => client.callTool({ name, arguments: args, _meta: { threadId: thread } });
  const progress = await call("save_progress", { summary: "PROTOCOL_RECOVERY_SENTINEL", next_steps: ["Continue protocol test"] });
  assert(!progress.isError, JSON.stringify(progress));
  const own = await call("briefing", { event: "resume", sections: ["checkpoint"] });
  assert(JSON.stringify(own).includes("PROTOCOL_RECOVERY_SENTINEL"));
  const other = await call("briefing", { event: "resume", sections: ["checkpoint"] }, "protocol-task-two");
  assert(!JSON.stringify(other).includes("PROTOCOL_RECOVERY_SENTINEL"));
  const item = await call("create_work_item", { content: "Protocol test work", status: "planned" });
  assert(!item.isError, JSON.stringify(item));
  const status = await call("system_status", {});
  assert(JSON.stringify(status).includes("codex-protocol-task-one"));
  const projectDb = new Database(join(project,".orchestrator","project.db"),{readonly:true});
  const globalDb = new Database(join(fixture,"global.db"),{readonly:true});
  try {
    for (const type of ["tool_capability","user_pattern"]) {
      const content = `EXPLICIT_PROJECT_${type} fixture scoped record`;
      await call("note",{type,scope:"project",content});
      const saved = projectDb.query("SELECT id FROM notes WHERE content=?").get(content) as any;
      assert(saved, `${type} ignored explicit project scope`);
      assert.equal(globalDb.query("SELECT id FROM notes WHERE content=?").get(content),null);
      if (type === "tool_capability") {
        const planned = await call("plan",{task:"Inspect fixture capability",domain:"EXPLICIT_PROJECT_tool_capability"});
        assert(JSON.stringify(planned).includes(content),"plan omitted project-scoped capability");
      }
      const replacement = `REPLACEMENT_${type} uncommon vocabulary protects scope`;
      await call("supersede_note",{old_id:saved.id,new_type:type,new_content:replacement});
      assert(projectDb.query("SELECT id FROM notes WHERE content=?").get(replacement),"Inline replacement changed scope");
      if (type === "tool_capability") {
        const planned = await call("plan",{task:"Inspect replacement capability",domain:"tool_capability"});
        assert(JSON.stringify(planned).includes(replacement));
        assert(!JSON.stringify(planned).includes(content),"plan retained superseded capability");
      }
    }
    assert.equal((globalDb.query("SELECT count(*) AS n FROM user_model").get() as any).n,0,"Project pattern leaked into global user model");
    await call("note",{type:"user_pattern",scope:"global",content:"GLOBAL_AUTHORIZED operator prefers explicit personal preferences"});
    assert.equal((globalDb.query("SELECT count(*) AS n FROM user_model").get() as any).n,1);
    await call("note",{type:"tool_capability",content:"DEFAULT_GLOBAL capability implies canonical legacy routing"});
    assert(globalDb.query("SELECT id FROM notes WHERE content LIKE 'DEFAULT_GLOBAL%'").get());
  } finally { projectDb.close(); globalDb.close(); }
  assert(!existsSync(join(project, ".orchestrator-state", "agent-channel")));
  assert(!stderr.includes("claude-ancestor") && !stderr.includes("dedup") && !stderr.includes("watchdog"), stderr);
  console.log(JSON.stringify({ ok: true, tools: tools.tools.length, fixture, version: client.getServerVersion() }));
} finally { await client.close(); }
