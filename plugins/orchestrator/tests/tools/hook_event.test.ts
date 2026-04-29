import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { SessionTracker } from "../../mcp/engine/session_tracker";
import { handleHookEvent } from "../../mcp/tools/hook_event";
import { _resetMessagingForTest } from "../../mcp/engine/messaging";
import { now } from "../../mcp/utils";

beforeEach(() => _resetMessagingForTest());

function freshSetup(): { db: Database; tracker: SessionTracker } {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  const tracker = new SessionTracker(db);
  return { db, tracker };
}

describe("hook_event dispatcher", () => {
  describe("UserPromptSubmit", () => {
    test("emits a rotating reminder variant on every turn", () => {
      const { db, tracker } = freshSetup();
      const r = handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "U1" });
      expect(r.additionalContext).toMatch(/^\[orch\]/);
    });

    test("rotates variants as the turn counter advances", () => {
      const { db, tracker } = freshSetup();
      const seen = new Set<string>();
      for (let i = 0; i < 12; i++) {
        const r = handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "rot" });
        // Take just the first 60 chars of the reminder to dedupe variant identity.
        const head = (r.additionalContext ?? "").split("\n")[0]?.slice(0, 60);
        if (head) seen.add(head);
      }
      // 12 turns through 12 variants should produce >=10 distinct first-lines.
      expect(seen.size).toBeGreaterThanOrEqual(10);
    });

    test("injects bridge content from the prior turn (PostToolUse -> UserPromptSubmit)", () => {
      const { db, tracker } = freshSetup();
      // Turn 1: UserPromptSubmit, then PostToolUse for two orchestrator tools.
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "B" });
      handleHookEvent(
        { db, tracker },
        {
          event: "PostToolUse",
          session_id: "B",
          tool_name: "mcp__plugin_orchestrator_memory__lookup",
        }
      );
      handleHookEvent(
        { db, tracker },
        {
          event: "PostToolUse",
          session_id: "B",
          tool_name: "mcp__plugin_orchestrator_memory__note",
        }
      );

      // Turn 2: bridge from turn 1 should be injected.
      const r = handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "B" });
      expect(r.additionalContext).toContain("Last turn bridge:");
      expect(r.additionalContext).toContain("lookup");
      expect(r.additionalContext).toContain("note");
    });

    test("resets per-turn struggle and orch-active markers on new turn", () => {
      const { db, tracker } = freshSetup();
      // Build up struggle counter to 2 (would soft-nudge on next failure).
      handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "S" });
      handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "S" });
      // New turn arrives.
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "S" });
      // Next failure should be silent (counter restarted at 1, < 2).
      const r = handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "S" });
      expect(r.additionalContext).toBeUndefined();
    });
  });

  describe("PreToolUse Option-B escalation", () => {
    test("turn 1: silent free pass (no nudge)", () => {
      const { db, tracker } = freshSetup();
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "P1" });
      const r = handleHookEvent(
        { db, tracker },
        { event: "PreToolUse", session_id: "P1", tool_name: "Edit" }
      );
      expect(r.additionalContext).toBeUndefined();
      expect(r.permissionDecision).toBeUndefined();
    });

    test("turn 2 with no orch activity: soft additionalContext", () => {
      const { db, tracker } = freshSetup();
      // Two UserPromptSubmits = turn counter 2.
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "P2" });
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "P2" });
      const r = handleHookEvent(
        { db, tracker },
        { event: "PreToolUse", session_id: "P2", tool_name: "Edit" }
      );
      expect(r.permissionDecision).toBe("allow");
      expect(r.additionalContext).toContain("Turn 2");
      expect(r.additionalContext).toContain("orchestrator tool");
    });

    test("turn 4+ with no orch activity: escalates to permissionDecision ask", () => {
      const { db, tracker } = freshSetup();
      for (let i = 0; i < 4; i++) {
        handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "P4" });
      }
      const r = handleHookEvent(
        { db, tracker },
        { event: "PreToolUse", session_id: "P4", tool_name: "Edit" }
      );
      expect(r.permissionDecision).toBe("ask");
      expect(r.permissionDecisionReason).toContain("turn 4");
    });

    test("orch tool call this turn defangs the nag", () => {
      const { db, tracker } = freshSetup();
      // Bump to turn 4 territory.
      for (let i = 0; i < 4; i++) {
        handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "P4ok" });
      }
      // Mark orch-active for this turn via a PostToolUse on an orchestrator tool.
      handleHookEvent(
        { db, tracker },
        {
          event: "PostToolUse",
          session_id: "P4ok",
          tool_name: "mcp__plugin_orchestrator_memory__lookup",
        }
      );
      const r = handleHookEvent(
        { db, tracker },
        { event: "PreToolUse", session_id: "P4ok", tool_name: "Edit" }
      );
      expect(r.permissionDecision).toBeUndefined();
      expect(r.additionalContext).toBeUndefined();
    });

    test("preuse-warned marker prevents firing twice in one turn", () => {
      const { db, tracker } = freshSetup();
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "P2x" });
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "P2x" });
      const r1 = handleHookEvent(
        { db, tracker },
        { event: "PreToolUse", session_id: "P2x", tool_name: "Edit" }
      );
      const r2 = handleHookEvent(
        { db, tracker },
        { event: "PreToolUse", session_id: "P2x", tool_name: "Edit" }
      );
      expect(r1.additionalContext).toContain("Turn 2");
      // Second call in same turn should be silent.
      expect(r2.additionalContext).toBeUndefined();
    });
  });

  describe("PostToolUse instrumentation", () => {
    test("orchestrator tool call sets orch-active marker for the turn", () => {
      const { db, tracker } = freshSetup();
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "OA" });
      handleHookEvent(
        { db, tracker },
        {
          event: "PostToolUse",
          session_id: "OA",
          tool_name: "mcp__plugin_orchestrator_memory__briefing",
        }
      );
      const turn = tracker.getCurrentTurn("OA");
      const row = db
        .query(`SELECT 1 FROM plugin_state WHERE key = ?`)
        .get(`orch_active_OA_${turn}`);
      expect(row).not.toBeNull();
    });

    test("non-orchestrator tool call does NOT set orch-active marker", () => {
      const { db, tracker } = freshSetup();
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "NO" });
      handleHookEvent(
        { db, tracker },
        { event: "PostToolUse", session_id: "NO", tool_name: "Edit" }
      );
      const turn = tracker.getCurrentTurn("NO");
      const row = db
        .query(`SELECT 1 FROM plugin_state WHERE key = ?`)
        .get(`orch_active_NO_${turn}`);
      expect(row).toBeNull();
    });

    test("any successful tool call resets the struggle counter", () => {
      const { db, tracker } = freshSetup();
      // Two failures: counter at 2.
      handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "RS" });
      handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "RS" });
      // A success comes through.
      handleHookEvent({ db, tracker }, { event: "PostToolUse", session_id: "RS", tool_name: "Read" });
      // Next failure should be silent (counter back at 0+1 = 1, < 2).
      const r = handleHookEvent({ db, tracker }, { event: "PostToolUseFailure", session_id: "RS" });
      expect(r.additionalContext).toBeUndefined();
    });
  });

  describe("Stop and SubagentStop", () => {
    test("Stop blocks with maintenance-verb prompt on first fire", () => {
      const { db, tracker } = freshSetup();
      const r = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "ST" });
      expect(r.decision).toBe("block");
      expect(r.reason).toContain("update_note");
      expect(r.reason).toContain("close_thread");
      expect(r.reason).toContain("supersede_note");
      expect(r.reason).toContain("save_progress");
    });

    test("SubagentStop blocks independently of Stop on the same session", () => {
      const { db, tracker } = freshSetup();
      const stop = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "Z" });
      const subStop = handleHookEvent({ db, tracker }, { event: "SubagentStop", session_id: "Z" });
      expect(stop.decision).toBe("block");
      expect(subStop.decision).toBe("block");
    });

    test("R3.4 nudge: lists fresh-surfaced notes when session_log has >=3", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("R34");
      const ts = now();
      // Insert 4 notes and log all as 'fresh' for session R34.
      for (let i = 0; i < 4; i++) {
        const id = `note-${i}`;
        db.run(
          `INSERT INTO notes (id, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          [id, "decision", `decision body ${i}`, ts, ts]
        );
        db.run(
          `INSERT INTO session_log (id, session_id, note_id, surfaced_at, turn_number, delivery_type)
           VALUES (?, 'R34', ?, ?, 1, 'fresh')`,
          [`log-${i}`, id, ts]
        );
      }

      const r = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "R34" });
      expect(r.decision).toBe("block");
      expect(r.reason).toContain("Notes this session surfaced");
      expect(r.reason).toContain("note-0");
      // 4 fresh - top 5 limit means all 4 listed, no "and N more" hint.
      expect(r.reason).not.toContain("more - find them with");
    });

    test("R3.4 nudge omitted when session has <3 fresh notes", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("R35");
      const ts = now();
      for (let i = 0; i < 2; i++) {
        const id = `n-${i}`;
        db.run(
          `INSERT INTO notes (id, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          [id, "decision", `body ${i}`, ts, ts]
        );
        db.run(
          `INSERT INTO session_log (id, session_id, note_id, surfaced_at, turn_number, delivery_type)
           VALUES (?, 'R35', ?, ?, 1, 'fresh')`,
          [`l-${i}`, id, ts]
        );
      }
      const r = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "R35" });
      expect(r.decision).toBe("block");
      expect(r.reason).not.toContain("Notes this session surfaced");
    });

    test("R3.4 nudge: 'and N more' appears when fresh count > 5", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("R36");
      const ts = now();
      for (let i = 0; i < 7; i++) {
        const id = `n6-${i}`;
        db.run(
          `INSERT INTO notes (id, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          [id, "decision", `body ${i}`, ts, ts]
        );
        db.run(
          `INSERT INTO session_log (id, session_id, note_id, surfaced_at, turn_number, delivery_type)
           VALUES (?, 'R36', ?, ?, 1, 'fresh')`,
          [`l6-${i}`, id, ts]
        );
      }
      const r = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "R36" });
      expect(r.reason).toContain("and 2 more");
    });

    test("Stop is idempotent per session: second call passes through", () => {
      const { db, tracker } = freshSetup();
      const first = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "I" });
      expect(first.decision).toBe("block");
      const second = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "I" });
      expect(second.decision).toBeUndefined();
    });
  });
});
