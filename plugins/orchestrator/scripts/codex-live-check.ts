// Explicit acceptance probe. Run only after snapshotting the selected live stores.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const [installed, project] = process.argv.slice(2);
if (!installed || !project) throw new Error("Usage: bun scripts/codex-live-check.ts INSTALLED_PLUGIN PROJECT");
const threadId = process.env.CODEX_THREAD_ID;
if (!threadId) throw new Error("Run this probe from a Codex task so its host identity is available");
const version = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version;
const client = new Client({ name: "codex-orchestrator-acceptance", version: "1" });
const env = { ...getDefaultEnvironment(), ORCHESTRATOR_HOST: "codex", ORCHESTRATOR_MODE: "standalone", ORCHESTRATOR_PROJECT_ROOT: resolve(project), ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) };
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(installed, "dist/server.js")], cwd: resolve(project), env, stderr: "pipe" });
transport.stderr?.on("data", chunk => process.stderr.write(chunk));
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args, _meta: { threadId } });
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, version);
  const known = await call("lookup", { id: "32034eab", output_mode: "summary" });
  assert(!known.isError && JSON.stringify(known).includes("32034eab"), "Existing KB record was not found");
  console.log(JSON.stringify({ kb: "existing record retrieved", version, taskIdentity: "host supplied" }));
  const deadline = Date.now() + 150000;
  for (;;) {
    const result = await call("system_status", {});
    const status = JSON.parse((result.content as { text: string }[])[0].text);
    assert.equal(status.session_id, `codex-${threadId}`);
    assert.equal(status.knowledge_root.toLowerCase(), resolve(project).toLowerCase());
    if (status.embeddings.status !== "starting" || Date.now() > deadline) {
      console.log(JSON.stringify({ embeddings: status.embeddings, projectNotes: status.project_notes }));
      break;
    }
    await Bun.sleep(2000);
  }
} finally { await client.close(); }
