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

// dd5d81d8: decision-surfacing UI tools. These are non-mutating tool_use
// blocks, so the old "text-or-mutating-tool" filter dropped them entirely -
// making an SA's question/plan to the user INVISIBLE to channel observers
// (PA). PA must be able to see that a decision was put to the user, and what.
const DECISION_SURFACING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

function isDecisionSurfacingTool(name: string): boolean {
  return DECISION_SURFACING_TOOLS.has(name);
}

/** Concise, bounded, redaction-safe summary of a decision-surfacing tool so a
 *  channel observer sees WHAT was asked without the full UI payload. Never
 *  throws (filterEvent must stay robust on malformed JSONL). */
function summarizeDecisionSurfacingTool(name: string, input: any): string {
  if (name === "ExitPlanMode") {
    return "[SA presented a plan for the user's approval]";
  }
  // AskUserQuestion
  try {
    const qs = Array.isArray(input?.questions) ? input.questions : [];
    if (qs.length === 0) {
      return "[SA asked the user a question (no detail available)]";
    }
    const parts = qs.slice(0, 4).map((q: any) => {
      const qText = String(q?.question ?? "a question").slice(0, 140);
      const opts = Array.isArray(q?.options)
        ? q.options
            .map((o: any) => String(o?.label ?? "").trim())
            .filter(Boolean)
            .join(" / ")
        : "";
      return opts ? `${qText} [options: ${opts}]` : qText;
    });
    const more = qs.length > 4 ? ` (+${qs.length - 4} more)` : "";
    return `[SA asked the user] ${parts.join(" || ")}${more}`.slice(0, 600);
  } catch {
    return "[SA asked the user a question]";
  }
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

    // Prefer a text block (most informative for cross-session awareness),
    // else fall back to a mutating tool_use. dd5d81d8: ALSO capture a
    // decision-surfacing UI tool (AskUserQuestion/ExitPlanMode) - it must
    // reach observers even though it's non-mutating. Scan ALL blocks (no
    // early return): the decision tool typically FOLLOWS an explainer text
    // block, and the text alone is misleading (it teases a question/plan the
    // observer can't see), so we need both before deciding.
    let firstText: string | null = null;
    let toolUseFallback: FilteredEvent | null = null;
    let decisionSummary: string | null = null;
    for (const b of blocks) {
      if (
        firstText === null &&
        b?.type === "text" &&
        typeof b.text === "string" &&
        b.text.trim()
      ) {
        firstText = b.text;
        continue;
      }
      if (b?.type === "tool_use" && typeof b.name === "string") {
        if (decisionSummary === null && isDecisionSurfacingTool(b.name)) {
          decisionSummary = summarizeDecisionSurfacingTool(b.name, b.input);
        } else if (!toolUseFallback && isMutatingTool(b.name)) {
          toolUseFallback = {
            event_type: "tool_use",
            tool_name: b.name,
            content: summarizeToolUse(b.name, b.input),
          };
        }
      }
    }

    // dd5d81d8: a decision-surfacing tool is forwarded as assistant_text -
    // appended to the explainer when present, or standing alone when not
    // (previously the whole event was silently dropped, blinding PA to the
    // SA's question/plan - the exact gap that caused PA's 7ff34714
    // misattribution this session).
    if (decisionSummary !== null) {
      return {
        event_type: "assistant_text",
        content:
          firstText !== null ? `${firstText}\n\n${decisionSummary}` : decisionSummary,
      };
    }
    if (firstText !== null) {
      return { event_type: "assistant_text", content: firstText };
    }
    return toolUseFallback;
  }

  if (raw.type === "summary" && typeof raw.summary === "string") {
    return { event_type: "summary", content: raw.summary };
  }

  return null;
}
