import {
  mkdirSync,
  copyFileSync,
  cpSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AppServer } from "./app-server";
import type { HelpConfig } from "./types";

export async function setupWorker(
  config: HelpConfig,
  pluginRoot: string,
  authHome?: string,
) {
  const home = resolve(config.codexHome);
  if (
    existsSync(join(home, "config.toml")) &&
    !existsSync(join(home, "spawnbox-help-home.json"))
  )
    throw new Error("Refusing to configure an existing non-HELP Codex home");
  mkdirSync(join(home, "runtime"), { recursive: true });
  for (const file of ["mcp.js", "help-guard.js", "memory-hook.js"])
    copyFileSync(join(pluginRoot, "dist", file), join(home, "runtime", file));
  mkdirSync(join(home, "skills"), { recursive: true });
  cpSync(join(pluginRoot, "skills"), join(home, "skills"), { recursive: true });
  cpSync(join(config.orchestratorRoot, "skills"), join(home, "skills"), {
    recursive: true,
  });
  // Explicit optional reuse of the operator's login. Nothing is copied to the
  // conversation workspace, embedded into prompts or passed to shell tools.
  if (authHome && !existsSync(join(home, "auth.json")))
    copyFileSync(join(authHome, "auth.json"), join(home, "auth.json"));
  const command = (name: string) =>
    `bun "${join(home, "runtime", name).replaceAll("\\", "/")}"`;
  const hooks: Record<string, unknown> = {};
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "Stop",
    "SessionEnd",
  ]) {
    hooks[event] = [
      {
        hooks: [
          { type: "command", command: command("memory-hook.js"), timeout: 30 },
        ],
      },
    ];
  }
  (hooks.PreToolUse as any[]).unshift({
    hooks: [
      { type: "command", command: command("help-guard.js"), timeout: 10 },
    ],
  });
  const app = new AppServer(config.codexExecutable, home, home);
  await app.start();
  try {
    const existing = await app.request("config/read", { includeLayers: false });
    // This is a dedicated home created by setup. Never overwrite an ordinary
    // user's Codex hooks or replace trust decisions for unrelated definitions.
    if (
      existing.config?.hooks &&
      !existsSync(join(home, "spawnbox-help-home.json"))
    )
      throw new Error("Refusing to replace hooks in a non-HELP Codex home");
    await app.request("config/batchWrite", {
      edits: [
        { keyPath: "hooks", value: hooks, mergeStrategy: "replace" },
        {
          keyPath: "features.shell_tool",
          value: false,
          mergeStrategy: "replace",
        },
      ],
      reloadUserConfig: true,
    });
    const inventory = await app.request("hooks/list", { cwds: [home] });
    const definitions = inventory.data.flatMap((entry: any) => entry.hooks);
    if (
      definitions.length !== 8 ||
      definitions.some(
        (h: any) =>
          ![command("memory-hook.js"), command("help-guard.js")].includes(
            h.command,
          ),
      )
    )
      throw new Error(
        "HELP hook inventory differs from the reviewed definitions",
      );
    await app.request("config/batchWrite", {
      edits: [
        {
          keyPath: "hooks.state",
          value: Object.fromEntries(
            definitions.map((h: any) => [
              h.key,
              { trusted_hash: h.currentHash },
            ]),
          ),
          mergeStrategy: "upsert",
        },
      ],
      reloadUserConfig: true,
    });
    writeFileSync(
      join(home, "spawnbox-help-home.json"),
      JSON.stringify(
        {
          version: 1,
          source: pluginRoot,
          hookHashes: definitions.map((h: any) => h.currentHash),
        },
        null,
        2,
      ),
    );
  } finally {
    await app.stop();
  }
}
