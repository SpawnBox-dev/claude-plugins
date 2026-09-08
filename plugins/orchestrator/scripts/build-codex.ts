import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const source = resolve(import.meta.dir, "..");
const artifact = resolve(source, "..", "orchestrator-codex");
const check = process.argv.includes("--check");
const target = check ? mkdtempSync(join(tmpdir(), "orchestrator-package-check-")) : artifact;
const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
// Keep a local reinstall cachebuster when rebuilding unchanged release sources.
try {
  const installedVersion = JSON.parse(readFileSync(join(artifact, ".codex-plugin/plugin.json"), "utf8")).version;
  if (installedVersion.split("+")[0] === pkg.version) pkg.version = installedVersion;
} catch { /* Initial build. */ }
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(pkg.version)) throw new Error("Invalid canonical package version");
const claude = JSON.parse(readFileSync(join(source, ".claude-plugin/plugin.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(resolve(source, "../../.claude-plugin/marketplace.json"), "utf8"));
if (claude.version !== pkg.version.split("+")[0] || marketplace.plugins.find((p: any) => p.name === "orchestrator").version !== claude.version) throw new Error("Canonical release versions disagree");
for (const dir of ["dist", "hooks", "skills", "sidecar", ".codex-plugin"]) mkdirSync(join(target, dir), { recursive: true });
for (const [entry, name] of [["mcp/server.ts", "server.js"], ["codex/hook-entry.ts", "hook.js"]]) {
  const result = await Bun.build({ entrypoints: [join(source, entry)], target: "bun", outdir: join(target, "dist"), naming: name });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
}
const json = (path: string, data: unknown) => writeFileSync(join(target, path), JSON.stringify(data, null, 2) + "\n");
json("package.json", { name: "orchestrator-codex", version: pkg.version, type: "module", engines: { bun: ">=1.3.0" } });
json(".codex-plugin/plugin.json", {
  name: "orchestrator-codex", version: pkg.version,
  description: "Persistent project knowledge, work tracking and continuity for independent Codex tasks.",
  author: { name: "SpawnBox-dev" }, skills: "./skills/", mcpServers: "./.mcp.json",
  interface: { displayName: "Orchestrator for Codex", shortDescription: "Project memory and continuity for independent tasks.", longDescription: "Shared project knowledge, work tracking, user preferences, lifecycle context and checkpoint recovery for independent Codex tasks.", developerName: "SpawnBox-dev", category: "Productivity", capabilities: ["skills", "MCP", "hooks"], defaultPrompt: "Brief me on this project's knowledge and current work." },
});
json(".mcp.json", { mcpServers: { orchestrator: {
  // Native .codex-plugin MCP args do not expand PLUGIN_ROOT in Codex 0.153.3.
  // Resolve this exact installed version without changing the project's cwd.
  // Do not pick a newest cache directory: it may belong to a disabled version.
  command: "bun", args: ["-e", `await import(require('node:url').pathToFileURL(require('node:path').join(process.env.CODEX_HOME || require('node:path').join(require('node:os').homedir(), '.codex'), 'plugins/cache/spawnbox-dev-codex-plugins/orchestrator-codex/${pkg.version}/dist/server.js')).href)`],
  env: { ORCHESTRATOR_HOST: "codex", ORCHESTRATOR_MODE: "standalone" },
  env_vars: ["CODEX_HOME", "ORCHESTRATOR_PROJECT_ROOT", "ORCHESTRATOR_WORKTREE_ROOT", "ORCHESTRATOR_GLOBAL_DB", "ORCHESTRATOR_EMBEDDINGS"],
} } });
const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop", "SessionEnd"];
json("hooks/hooks.json", { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: "command", command: 'bun "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"', timeout: 10, ...(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"].includes(event) ? { additionalContextLimit: 2500 } : {}) }] }]])) });
cpSync(join(source, "codex", "skills"), join(target, "skills"), { recursive: true });
cpSync(join(source, "codex", "README.md"), join(target, "README.md"));
// Ship authored resources only; never copy a local Python environment or model cache.
for (const file of readdirSync(join(source, "sidecar"))) {
  if (statSync(join(source, "sidecar", file)).isFile() && /\.(py|toml|lock|txt)$/.test(file)) cpSync(join(source, "sidecar", file), join(target, "sidecar", file));
}
if (check) {
  const files = (root: string, prefix = ""): string[] => readdirSync(join(root, prefix)).flatMap(file => statSync(join(root, prefix, file)).isDirectory() ? files(root, join(prefix, file)) : [join(prefix, file)]).sort();
  const expected = files(target);
  if (JSON.stringify(expected) !== JSON.stringify(files(artifact))) throw new Error("Codex package file inventory differs from authored sources");
  for (const file of expected) if (readFileSync(join(target, file), "utf8").replace(/\r\n/g, "\n") !== readFileSync(join(artifact, file), "utf8").replace(/\r\n/g, "\n")) throw new Error(`Stale generated artifact: ${file}. Run bun run build:codex.`);
  console.log(`Verified orchestrator-codex ${pkg.version}: ${expected.length} generated files`);
} else console.log(`Built orchestrator-codex ${pkg.version}`);
