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

    // Skip channel-injected content (echo prevention). Two variants:
    //
    // 1. Raw `<channel ...>` tag form - what arrives when CC injects a
    //    channel notification into a receiving session's prompt. CC records
    //    that injection in the JSONL as a `user`-typed entry. Without this
    //    filter, every original event causes N echoes (one per channel-
    //    attached sibling). 0.29.9 added this filter.
    //
    // 2. `← core:` display form - what shows in CC's terminal pane when the
    //    channel content is collapsed for visual display. If the user
    //    copies a line from their scrollback and pastes it back, the paste
    //    arrives as user_input starting with `← core:`. Without filtering,
    //    that paste gets re-broadcast (and if the pasted text contained any
    //    `@SA-<id8>` patterns, those would route as a directive even though
    //    the user just meant to quote). 0.30.5 added this filter.
    //
    // The receiving session never types `<channel ...>` or `← core:` as
    // genuine user input themselves, so dropping these is safe.
    if (/^\s*<channel\b/.test(text)) return null;
    if (/^\s*←\s*core:/i.test(text)) return null;

    return { event_type: "user_input", content: text };
  }

  if (raw.type === "assistant") {
    const blocks = raw.message?.content;
    if (!Array.isArray(blocks)) return null;

    // Prefer a text block (most informative for cross-session awareness).
    // Walk all blocks; only fall back to a mutating tool_use if no text.
    // CRITICAL: the original implementation `return null`-ed on a non-mutating
    // tool_use block, which silently dropped any assistant message whose first
    // block was a Read/Grep/etc. (very common - tool-call-then-text pattern).
    let toolUseFallback: FilteredEvent | null = null;
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        return { event_type: "assistant_text", content: b.text };
      }
      if (
        !toolUseFallback &&
        b?.type === "tool_use" &&
        typeof b.name === "string" &&
        isMutatingTool(b.name)
      ) {
        toolUseFallback = {
          event_type: "tool_use",
          tool_name: b.name,
          content: summarizeToolUse(b.name, b.input),
        };
      }
    }
    return toolUseFallback;
  }

  if (raw.type === "summary" && typeof raw.summary === "string") {
    return { event_type: "summary", content: raw.summary };
  }

  return null;
}
