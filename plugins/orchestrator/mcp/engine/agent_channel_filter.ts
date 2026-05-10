/**
 * JSONL event filter for the agent-channel filewatcher.
 *
 * Decides which raw JSONL events warrant forwarding to other sessions and
 * normalizes the survivors into a small structural shape (FilteredEvent) the
 * filewatcher hands to the addressing parser + notification emitter.
 *
 * Forwarding policy (per spec decision 4):
 *   - Forward: user input, assistant text, mutating tool calls
 *     (Edit/Write/Bash/MultiEdit/git_*), summary events.
 *   - Drop: tool_result bodies, system messages, read-only tool calls.
 *
 * If PA wants details on a dropped event (e.g. tool_result content), it can
 * read the JSONL file directly. The filter keeps signal-over-noise high.
 */

export interface FilteredEvent {
  event_type: "user_input" | "assistant_text" | "tool_use" | "summary";
  content: string;
  tool_name?: string;
}

const MUTATING_TOOLS = new Set(["Edit", "Write", "Bash", "MultiEdit"]);

function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name) || name.startsWith("git_");
}

function summarizeToolUse(name: string, input: any): string {
  if (name === "Edit" || name === "Write" || name === "MultiEdit") {
    const path = input?.file_path ?? "<unknown>";
    return `[tool: ${name} ${path}]`;
  }
  if (name === "Bash") {
    const cmd = String(input?.command ?? "").slice(0, 80);
    return `[tool: Bash $ ${cmd}${cmd.length === 80 ? "..." : ""}]`;
  }
  return `[tool: ${name}]`;
}

export function filterEvent(raw: any): FilteredEvent | null {
  if (!raw || typeof raw !== "object" || !("type" in raw)) return null;

  if (raw.type === "user") {
    const msg = raw.message;
    // Skip user events that are tool_result wrappers
    if (
      Array.isArray(msg?.content) &&
      msg.content.some((c: any) => c?.type === "tool_result")
    ) {
      return null;
    }
    const text = typeof msg?.content === "string" ? msg.content : null;
    if (!text) return null;
    return { event_type: "user_input", content: text };
  }

  if (raw.type === "assistant") {
    const blocks = raw.message?.content;
    if (!Array.isArray(blocks)) return null;
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        return { event_type: "assistant_text", content: b.text };
      }
      if (b?.type === "tool_use" && typeof b.name === "string") {
        if (!isMutatingTool(b.name)) return null;
        return {
          event_type: "tool_use",
          tool_name: b.name,
          content: summarizeToolUse(b.name, b.input),
        };
      }
    }
    return null;
  }

  if (raw.type === "summary" && typeof raw.summary === "string") {
    return { event_type: "summary", content: raw.summary };
  }

  return null;
}
