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
});
