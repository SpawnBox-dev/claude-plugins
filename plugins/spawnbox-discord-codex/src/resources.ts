import { readFileSync, realpathSync, statSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import type { HelpConfig, Job } from "./types";

const policyFiles: Record<string, string> = {
  engagement: ".claude/discord-engagement.md",
  channels: ".claude/discord-channels-bootstrap.md",
  help: ".claude/commands/discord-help.md",
  triage: ".claude/commands/discord-triage.md",
  "helper-review": ".claude/commands/discord-review-helper-application.md",
  roadmap: ".claude/commands/discord-post-roadmap.md",
  diagnostics: ".claude/commands/diag-report-investigation.md",
};
export function contained(root: string, path: string): string {
  const actual = realpathSync(path),
    base = realpathSync(root),
    rel = relative(base, actual);
  if (
    rel === ".." ||
    rel.startsWith("..\\") ||
    rel.startsWith("../") ||
    isAbsolute(rel)
  )
    throw new Error("Resource escapes configured root");
  return actual;
}
export function readResource(
  config: HelpConfig,
  job: Job,
  kind: string,
  name: string,
  offset = 0,
): { text: string; total: number; next?: number } {
  let file: string;
  let resourceRoot = config.projectRoot;
  if (kind === "skill") {
    if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("Invalid skill name");
    resourceRoot = join(config.codexHome, "skills");
    file = join(resourceRoot, name, "SKILL.md");
  } else if (kind === "policy") {
    if (!policyFiles[name]) throw new Error("Unknown policy resource");
    file = resolve(config.projectRoot, policyFiles[name]);
  } else if (kind === "source") {
    const normalized = name.replaceAll("\\", "/");
    const allowed = (path: string) =>
      !path.split("/").some((part) => part === ".." || part === ".") &&
      /^(worker\/src\/|worker\/scripts\/|src\/|docs\/)/.test(path) &&
      /\.(ts|tsx|js|md|json|sql|py|rs|toml)$/.test(path) &&
      !/(?:^|\/)(?:\.env|secrets?|credentials?|settings\.local|auth)(?:[.\/]|$)/i.test(
        path,
      );
    if (!allowed(normalized))
      throw new Error("Source path is not in the reviewed read-only surface");
    file = resolve(config.projectRoot, normalized);
    const actual = contained(config.projectRoot, file);
    if (
      !allowed(
        relative(realpathSync(config.projectRoot), actual).replaceAll(
          "\\",
          "/",
        ),
      )
    )
      throw new Error("Resolved source path is outside the reviewed surface");
  } else if (kind === "user-note" || kind === "channel-note") {
    const directory =
      kind === "user-note"
        ? ".claude/discord-user-notes"
        : ".claude/discord-channel-notes";
    const key = kind === "user-note" ? job.event.userId : job.event.channelId;
    const mapFile = join(config.projectRoot, directory, "_map.json");
    const map = existsSync(mapFile)
      ? JSON.parse(readFileSync(mapFile, "utf8"))
      : {};
    const mapped = map[key];
    const filename = existsSync(
      join(config.projectRoot, directory, `${key}.md`),
    )
      ? `${key}.md`
      : typeof mapped === "string"
        ? mapped
        : mapped?.file;
    if (!filename) return { text: "No existing scoped note", total: 0 };
    file = contained(
      join(config.projectRoot, directory),
      resolve(config.projectRoot, directory, filename),
    );
  } else throw new Error("Unknown resource kind");
  file = contained(resourceRoot, file);
  if (statSync(file).size > 1024 * 1024)
    throw new Error("Resource exceeds 1 MiB; request a narrower artifact");
  const text = readFileSync(file, "utf8");
  return {
    text: text.slice(offset, offset + 24000),
    total: text.length,
    ...(text.length > offset + 24000 ? { next: offset + 24000 } : {}),
  };
}
