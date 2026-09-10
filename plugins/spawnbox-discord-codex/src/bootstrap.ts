import { createHash } from "node:crypto";
import { readResource } from "./resources";
import type { HelpConfig, Job } from "./types";

// Hash only approved resources, including all pages. No policy or private note
// contents are copied into an event prompt. Failed reads disable reuse.
export function bootstrapRevision(config: HelpConfig, job: Job): string | undefined {
  const hash = createHash("sha256").update(job.event.userId).update(job.event.channelId);
  const resources: [string, string][] = [
    ...["bootstrap", "reference", "engagement", "channels", "help", "triage", "helper-review", "roadmap", "diagnostics"].map(name => ["policy", name] as [string,string]),
    ...["discord-bootstrap", "discord-help", "discord-triage", "discord-review-helper-application", "discord-post-roadmap"].map(name => ["skill", name] as [string,string]),
    ["user-note", "current"], ["channel-note", "current"],
  ];
  try {
    for (const [kind, name] of resources) {
      hash.update(JSON.stringify([kind, name]));
      let offset = 0;
      for (;;) {
        const page = readResource(config, job, kind, name, offset);
        hash.update(page.text);
        if (page.next === undefined) break;
        offset = page.next;
      }
    }
    return hash.digest("hex");
  } catch { return undefined; }
}

export const bootstrapRequired = "Run discord-bootstrap before any outward action: this worker is starting, recovering, handling a different participant, or its approved policy/skill/note resources changed or could not be verified.";
export const bootstrapReusable = "This conversation continues in the same worker with unchanged approved resources and participant. Reuse the loaded persona/policy context; do not repeat the entire bootstrap just because the host called thread/resume. Still call context, inspect relevant new history, and refresh any missing context before acting.";

export function helpRecoveryContext(input: any, result: Record<string, any>): Record<string, any> {
  if (input.hook_event_name !== "SessionStart" || input.source !== "compact") return result;
  const output = result.hookSpecificOutput ?? {};
  return { ...result, hookSpecificOutput: { ...output, hookEventName: "SessionStart",
    additionalContext: `${output.additionalContext ?? ""}\n[HELP] Context was compacted. Read discord-bootstrap using read_resource(kind="skill", name="discord-bootstrap") and refresh persona/policy and the conversation checkpoint before outward actions.` } };
}
