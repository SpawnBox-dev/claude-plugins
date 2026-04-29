import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { SessionTracker } from "../../mcp/engine/session_tracker";
import { handleHookEvent } from "../../mcp/tools/hook_event";
import {
  sendMessage,
  loadInboxCounters,
  _resetMessagingForTest,
} from "../../mcp/engine/messaging";

beforeEach(() => _resetMessagingForTest());

function freshSetup(): { db: Database; tracker: SessionTracker } {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  const tracker = new SessionTracker(db);
  return { db, tracker };
}

describe("cross-session messaging integration", () => {
  test("session A sends -> session B receives via PostToolUse hook", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("A");
    tracker.registerSession("B");

    sendMessage(db, {
      from_session: "A",
      to_session: "B",
      body: "heads up - touching the same file you are",
    });

    const result = handleHookEvent(
      { db, tracker },
      { event: "PostToolUse", session_id: "B", tool_name: "Edit" }
    );

    expect(result.additionalContext).toContain("heads up");
    expect(result.additionalContext).toContain("from A");
  });

  test("UserPromptSubmit injects sibling activity when present", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("X");
    tracker.registerSession("Y");
    tracker.updateCurrentTask("Y", "refactoring observer connect");

    const result = handleHookEvent(
      { db, tracker },
      { event: "UserPromptSubmit", session_id: "X" }
    );

    expect(result.additionalContext).toContain("refactoring observer connect");
  });

  test("fast path: no messages, no siblings -> no inter-session content", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("solo");
    loadInboxCounters(db);

    const result = handleHookEvent(
      { db, tracker },
      { event: "PostToolUse", session_id: "solo", tool_name: "Read" }
    );

    // PostToolUse with empty inbox should produce no additionalContext at all,
    // so the model pays zero token cost on idle turns.
    expect(result.additionalContext).toBeUndefined();
  });

  test("Stop blocks once per session, then passes through", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("S");

    const first = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "S" });
    expect(first.decision).toBe("block");

    const second = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "S" });
    expect(second.decision).toBeUndefined();
  });

  test("PreCompact emits a systemMessage", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("S");
    const result = handleHookEvent({ db, tracker }, { event: "PreCompact", session_id: "S" });
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("compaction");
  });

  test("PostToolUseFailure escalates from soft to hard at >=3 consecutive", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("F");

    const r1 = handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "F" });
    expect(r1.additionalContext).toBeUndefined();

    const r2 = handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "F" });
    expect(r2.additionalContext).toContain("Two tool calls failed");

    const r3 = handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "F" });
    expect(r3.additionalContext).toContain("STOP");
  });

  test("UserPromptSubmit resets struggle counter for the new turn", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("R");

    handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "R" });
    handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "R" });
    // Counter is now 2. New turn should reset to 0.
    handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "R" });
    const r1 = handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "R" });
    // Should be silent again because counter restarted at 0+1 = 1, < 2.
    expect(r1.additionalContext).toBeUndefined();
  });

  test("PostToolUse delivers a scoped message when file_path matches scope.code_ref (R7.5)", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("E");
    tracker.registerSession("Sender");
    sendMessage(db, {
      from_session: "Sender",
      to_session: "E",
      body: "watch out, this file has a known race",
      scope: { code_ref: "src/foo.ts" },
    });

    // R7.5: scoped delivery requires matching context. The PostToolUse
    // dispatcher passes file_path through as drain context.
    const result = handleHookEvent(
      { db, tracker },
      {
        event: "PostToolUse",
        session_id: "E",
        tool_name: "Edit",
        payload: { file_path: "/abs/src/foo.ts" },
      }
    );

    expect(result.additionalContext).toContain("known race");
    expect(result.additionalContext).toContain("scoped to src/foo.ts");
  });

  test("PostToolUse on unrelated file does NOT deliver a scoped message (R7.5)", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("E2");
    tracker.registerSession("Sender2");
    sendMessage(db, {
      from_session: "Sender2",
      to_session: "E2",
      body: "scoped to api",
      scope: { code_ref: "src/api.ts" },
    });

    const result = handleHookEvent(
      { db, tracker },
      {
        event: "PostToolUse",
        session_id: "E2",
        tool_name: "Read",
        payload: { file_path: "src/utils.ts" },
      }
    );

    // Message stays queued; not delivered.
    expect(result.additionalContext).toBeUndefined();
  });

  test("PostToolUse fast path delivers pending direct message", () => {
    const { db, tracker } = freshSetup();
    tracker.registerSession("Sender");
    tracker.registerSession("R");

    sendMessage(db, { from_session: "Sender", to_session: "R", body: "ping", priority: "high" });

    const result = handleHookEvent(
      { db, tracker },
      { event: "PostToolUse", session_id: "R", tool_name: "Read" }
    );

    expect(result.additionalContext).toContain("ping");
    expect(result.additionalContext).toContain("HIGH");
  });
});
