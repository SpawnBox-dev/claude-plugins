// Read-only import of the existing HELP identity/admission policy. Never changes
// Claude state, fetches message content, registers commands or starts a Gateway.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { configSchema } from "../src/config";
const [projectArg, stateArg, executableArg] = process.argv.slice(2);
if (!projectArg || !stateArg || !executableArg)
  throw new Error(
    "Usage: import-help-config.ts <project> <state> <native codex.exe>",
  );
const project = resolve(projectArg),
  state = resolve(stateArg);
const access = JSON.parse(
  readFileSync(join(homedir(), ".claude/channels/discord/access.json"), "utf8"),
);
if (access.dmPolicy !== "allowlist")
  throw new Error(
    "Existing DM policy needs explicit translation; expected allowlist",
  );
const settings = JSON.parse(
  readFileSync(join(project, ".claude/settings.local.json"), "utf8"),
);
const token = settings.env?.DISCORD_HELP_BOT_TOKEN;
if (!token)
  throw new Error(
    "HELP token is not configured in the expected local settings",
  );
const get = async (path: string) => {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!response.ok)
    throw new Error(`Discord read ${path}: HTTP ${response.status}`);
  return (await response.json()) as any;
};
const me = await get("/users/@me");
if (me.id !== "1493368365354582206")
  throw new Error(
    "Configured HELP credential identifies a different application",
  );
const guild = "1471275385462456479";
const channels = await get(`/guilds/${guild}/channels`);
const webhooks = await get(`/guilds/${guild}/webhooks`);
const byId = new Map<string, any>(channels.map((c: any) => [c.id, c]));
const policies: Record<string, any> = {};
for (const [id, rule] of Object.entries(access.groups || {}) as [
  string,
  any,
][]) {
  const channel = byId.get(id);
  if (!channel)
    throw new Error(
      `Allowlisted channel ${id} absent from guild inventory; review rather than silently discard`,
    );
  const overwrites = channel.permission_overwrites || [];
  const everyone = overwrites.find((o: any) => o.id === guild);
  const privateRoom = everyone && (BigInt(everyone.deny) & 1024n) !== 0n;
  const helper = overwrites.some(
    (o: any) =>
      o.id === "1494801049658065091" && (BigInt(o.allow) & 1024n) !== 0n,
  );
  const namedStaff = [
    "1471756652264034359",
    "1485880246711488524",
    "1494801214934614046",
  ].includes(id);
  const audience = namedStaff
    ? "staff"
    : id === "1494801163680354481"
      ? "helpers"
      : privateRoom
        ? channel.name.startsWith("support-")
          ? "private"
          : helper
            ? "helpers"
            : "staff"
        : "public";
  policies[id] = {
    audience,
    requireMention: !!rule.requireMention,
    allowUsers: rule.allowFrom || [],
  };
}
const codexConfig = Bun.TOML.parse(
  readFileSync(join(homedir(), ".codex/config.toml"), "utf8"),
) as any;
if (typeof codexConfig.model !== "string")
  throw new Error("Could not derive configured Codex model");
const config = configSchema.parse({
  schemaVersion: 1,
  projectRoot: project,
  botApplicationId: me.id,
  guildId: guild,
  ownerIds: ["1471274334474600710"],
  dmAllowUsers: access.allowFrom || [],
  channels: policies,
  diagnosticWebhooks: {
    "1485880246711488524": webhooks
      .filter((w: any) => w.channel_id === "1485880246711488524")
      .map((w: any) => w.id),
  },
  model: codexConfig.model,
  codexExecutable: resolve(executableArg),
  codexHome: join(state, "codex-home"),
  orchestratorRoot: resolve(import.meta.dir, "../../orchestrator-codex"),
  maxConcurrency: 2,
  catchupPageLimit: 50,
});
mkdirSync(state, { recursive: true });
writeFileSync(
  join(state, "config.json"),
  JSON.stringify(config, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    configured: true,
    applicationId: me.id,
    channels: Object.keys(policies).length,
    audiences: Object.values(policies).reduce(
      (a: any, p: any) => ({ ...a, [p.audience]: (a[p.audience] || 0) + 1 }),
      {},
    ),
    diagnosticWebhooks: config.diagnosticWebhooks["1485880246711488524"].length,
    dmRecipients: config.dmAllowUsers.length,
    model: config.model,
    started: false,
  }),
);
