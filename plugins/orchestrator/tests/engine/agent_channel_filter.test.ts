import { describe, expect, test } from "bun:test";
import { filterEvent } from "../../mcp/engine/agent_channel_filter";

describe("agent-channel filter", () => {
  test("user input forwarded", () => {
    const ev = filterEvent({
      type: "user",
      message: { content: "PA, status update?" },
    });
    expect(ev?.event_type).toBe("user_input");
    expect(ev?.content).toBe("PA, status update?");
  });

  test("assistant text forwarded", () => {
    const ev = filterEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "Done. Pushed." }] },
    });
    expect(ev?.event_type).toBe("assistant_text");
    expect(ev?.content).toBe("Done. Pushed.");
  });

  test("assistant tool_use - mutating Edit forwarded as summary", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "src/foo.ts", old_string: "x", new_string: "y" },
          },
        ],
      },
    });
    expect(ev?.event_type).toBe("tool_use");
    expect(ev?.tool_name).toBe("Edit");
    expect(ev?.content).toContain("Edit");
    expect(ev?.content).toContain("src/foo.ts");
  });

  test("assistant tool_use - Bash forwarded with first 80 chars of command", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "git commit -m 'long message that goes on and on and on'" },
          },
        ],
      },
    });
    expect(ev?.event_type).toBe("tool_use");
    expect(ev?.tool_name).toBe("Bash");
    expect(ev?.content).toContain("git commit");
  });

  test("assistant tool_use - Read DROPPED", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }],
      },
    });
    expect(ev).toBeNull();
  });

  test("assistant tool_use - Grep DROPPED", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Grep", input: { pattern: "x" } }],
      },
    });
    expect(ev).toBeNull();
  });

  test("tool_result dropped", () => {
    const ev = filterEvent({
      type: "user",
      message: { content: [{ type: "tool_result", content: "huge dump" }] },
    });
    expect(ev).toBeNull();
  });

  test("system message dropped", () => {
    const ev = filterEvent({ type: "system", message: { content: "hook fired" } });
    expect(ev).toBeNull();
  });

  test("summary event forwarded", () => {
    const ev = filterEvent({ type: "summary", summary: "compaction summary text" });
    expect(ev?.event_type).toBe("summary");
    expect(ev?.content).toBe("compaction summary text");
  });

  test("malformed event returns null", () => {
    expect(filterEvent({})).toBeNull();
    expect(filterEvent(null)).toBeNull();
    expect(filterEvent({ type: "weird" })).toBeNull();
  });

  // Regression: previously a non-mutating tool_use as the FIRST block of an
  // assistant message caused the whole event to be dropped, even if a
  // following text block contained content. Code-review caught this.
  test("assistant with non-mutating tool_use FIRST then text - text wins", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "x" } },
          { type: "text", text: "Done. Here is what I found: ..." },
        ],
      },
    });
    expect(ev?.event_type).toBe("assistant_text");
    expect(ev?.content).toBe("Done. Here is what I found: ...");
  });

  test("assistant with mutating tool_use FIRST and text after - prefers text", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "src/foo.ts" } },
          { type: "text", text: "Edited foo.ts to handle null" },
        ],
      },
    });
    expect(ev?.event_type).toBe("assistant_text");
    expect(ev?.content).toBe("Edited foo.ts to handle null");
  });

  test("assistant with only mutating tool_use (no text) - falls back to tool summary", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "x" } },
          { type: "tool_use", name: "Edit", input: { file_path: "src/foo.ts" } },
        ],
      },
    });
    expect(ev?.event_type).toBe("tool_use");
    expect(ev?.tool_name).toBe("Edit");
  });

  test("assistant with only non-mutating tool_use (no text) - dropped", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "x" } },
          { type: "tool_use", name: "Grep", input: { pattern: "y" } },
        ],
      },
    });
    expect(ev).toBeNull();
  });

  // dd5d81d8: decision-surfacing UI tools (AskUserQuestion / ExitPlanMode)
  // are non-mutating tool_use and were therefore INVISIBLE to channel
  // observers (PA). A channel observer must be able to see that an SA put a
  // decision to the user, and what it was.

  test("AskUserQuestion only (no text) - forwarded as a question summary, not dropped", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Push to origin now or hold?",
                  header: "Deploy",
                  options: [
                    { label: "Push now", description: "..." },
                    { label: "Hold", description: "..." },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    expect(ev).not.toBeNull();
    expect(ev?.event_type).toBe("assistant_text");
    expect(ev?.content).toContain("asked the user");
    expect(ev?.content).toContain("Push to origin now or hold?");
    expect(ev?.content).toContain("Push now");
    expect(ev?.content).toContain("Hold");
  });

  test("text + AskUserQuestion - text forwarded WITH the question summary appended (the PA-invisible gap)", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Here is the tradeoff analysis." },
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which approach?",
                  options: [{ label: "A" }, { label: "B" }],
                },
              ],
            },
          },
        ],
      },
    });
    expect(ev?.event_type).toBe("assistant_text");
    expect(ev?.content).toContain("Here is the tradeoff analysis.");
    expect(ev?.content).toContain("asked the user");
    expect(ev?.content).toContain("Which approach?");
    expect(ev?.content).toContain("A");
    expect(ev?.content).toContain("B");
  });

  test("ExitPlanMode only - forwarded as a plan-presented signal, not dropped", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "ExitPlanMode", input: { plan: "do X then Y" } },
        ],
      },
    });
    expect(ev).not.toBeNull();
    expect(ev?.content.toLowerCase()).toContain("plan");
  });

  test("malformed AskUserQuestion input does not throw - forwards a generic marker", () => {
    const ev = filterEvent({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "AskUserQuestion", input: {} }],
      },
    });
    expect(ev).not.toBeNull();
    expect(ev?.content.toLowerCase()).toContain("asked the user");
  });

  test("regression: plain text with NO decision-surfacing tool is forwarded verbatim (no spurious append)", () => {
    const ev = filterEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "Just a status line." }] },
    });
    expect(ev?.event_type).toBe("assistant_text");
    expect(ev?.content).toBe("Just a status line.");
  });
});
