import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
process.chdir(root);
const entries = {
  cli: "src/cli.ts",
  mcp: "src/mcp.ts",
  "help-guard": "src/guard.ts",
  "memory-hook": "src/memory-hook.ts",
};
mkdirSync(join(root, "dist"), { recursive: true });
for (const [name, entry] of Object.entries(entries)) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: join(root, "dist"),
    naming: `${name}.js`,
    target: "bun",
    minify: false,
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
  // Bun preserves whitespace-only lines in embedded dependency license comments.
  // Normalize only those comments; never alter whitespace inside code strings.
  const output = join(root, "dist", `${name}.js`);
  writeFileSync(output, readFileSync(output, "utf8").replace(
    /\/\*! Bundled license information:[\s\S]*?\*\//g,
    comment => comment.replace(/[ \t]+$/gm, ""),
  ));
}
const manifest = JSON.parse(
  readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"),
);
// As with orchestrator-codex, Codex 0.153.3 does not expand plugin-root placeholders
// in MCP args. Bind to this exact version's cache namespace, never a newest cache.
const boot = `const p=require('node:path');const h=process.env.CODEX_HOME||p.join(require('node:os').homedir(),'.codex');import(require('node:url').pathToFileURL(p.join(h,'plugins/cache/spawnbox-dev-codex-plugins/spawnbox-discord-codex/${manifest.version}/dist/mcp.js')).href).then(m=>m.startMcp())`;
writeFileSync(
  join(root, ".mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        spawnbox_discord: {
          command: "bun",
          args: ["-e", boot],
          env_vars: [
            "CODEX_HOME",
            "SPAWNBOX_HELP_ENDPOINT",
            "SPAWNBOX_HELP_CLIENT_TOKEN",
          ],
        },
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(`Built HELP service, MCP client and guards (${manifest.version})`);
