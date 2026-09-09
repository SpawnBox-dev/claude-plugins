import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { AppServer, childEnvironment } from "../src/app-server";
const fixture = mkdtempSync(join(tmpdir(), "help-installed-test-"));
const home = join(fixture, "home"),
  project = join(fixture, "project");
mkdirSync(home);
mkdirSync(project);
const executable = process.env.CODEX_EXECUTABLE || "codex";
const env = childEnvironment(home);
for (const args of [
  [
    "plugin",
    "marketplace",
    "add",
    resolve(import.meta.dir, "../../.."),
    "--json",
  ],
  [
    "plugin",
    "add",
    "spawnbox-discord-codex@spawnbox-dev-codex-plugins",
    "--json",
  ],
])
  execFileSync(executable, args, {
    env,
    cwd: project,
    windowsHide: true,
    stdio: "pipe",
  });
const app = new AppServer(executable, home, project);
try {
  await app.start();
  const start = await app.request("thread/start", {
    cwd: project,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const status = await app.request("mcpServerStatus/list", {
    threadId: start.thread.id,
  });
  const discord = status.data.find(
    (server: any) => server.name === "spawnbox_discord",
  );
  assert(discord, "Installed MCP missing");
  assert(
    Object.keys(discord.tools || {}).length === 18,
    `Expected 18 HELP tools; received ${Object.keys(discord.tools || {}).length}`,
  );
  const result = await app.request("mcpServer/tool/call", {
    threadId: start.thread.id,
    server: "spawnbox_discord",
    tool: "context",
    arguments: {},
  });
  assert(
    result.isError && JSON.stringify(result).includes("not connected"),
    "Passive installation should initialize but explain its disconnected service",
  );
  console.log(
    JSON.stringify({
      ok: true,
      installedPlugin: true,
      tools: Object.keys(discord.tools).length,
      passive: true,
    }),
  );
} finally {
  await app.stop();
}
