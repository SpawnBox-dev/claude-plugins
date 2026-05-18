import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { applyMigrations } from "../../mcp/db/schema";
import { SessionTracker } from "../../mcp/engine/session_tracker";
import {
  handleHookEvent,
  buildHookEnvelope,
  composePostCompactReorientation,
  HOOK_EVENTS,
} from "../../mcp/tools/hook_event";
import { now } from "../../mcp/utils";

function freshSetup(): { db: Database; tracker: SessionTracker } {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  const tracker = new SessionTracker(db, () => null);
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
          tool_name: "mcp__plugin_orchestrator_core__lookup",
        }
      );
      handleHookEvent(
        { db, tracker },
        {
          event: "PostToolUse",
          session_id: "B",
          tool_name: "mcp__plugin_orchestrator_core__note",
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
          tool_name: "mcp__plugin_orchestrator_core__lookup",
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
          tool_name: "mcp__plugin_orchestrator_core__briefing",
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
      expect(r.reason).toContain("4 fresh notes surfaced");
      expect(r.reason).toContain("note-0");
      // 4 fresh - top 3 limit means 1 left as "and N more".
      expect(r.reason).toContain("and 1 more");
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

    test("R7.6 'and N more' appears when fresh count > 3 (R7.6 cap)", () => {
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
      // 7 fresh - 3 listed = 4 more.
      expect(r.reason).toContain("and 4 more");
    });

    test("Stop is idempotent per session: second call passes through", () => {
      const { db, tracker } = freshSetup();
      const first = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "I" });
      expect(first.decision).toBe("block");
      const second = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "I" });
      expect(second.decision).toBeUndefined();
    });

    test("R7.7: PreCompact stamps a marker that suppresses the immediate Stop block", () => {
      // Field-observed bug: /compact fires PreCompact + Stop on the same boundary,
      // and the Stop block derails the compact flow with redundant housekeeping
      // text (PreCompact already requested capture). PreCompact should arm a
      // suppression marker that handleStop honors.
      const { db, tracker } = freshSetup();
      const pre = handleHookEvent({ db, tracker }, { event: "PreCompact", session_id: "CMP" });
      expect(pre.systemMessage).toContain("Context compaction imminent");

      const stop = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "CMP" });
      // The compaction-driven Stop must NOT block.
      expect(stop.decision).toBeUndefined();
      expect(stop.reason).toBeUndefined();
    });

    test("R7.7: Stop block is restored on the NEXT real (non-compact) stop", () => {
      // After PreCompact suppresses one Stop, the marker is consumed - the
      // next genuine Stop (post-compact, after user finishes) blocks normally.
      const { db, tracker } = freshSetup();
      handleHookEvent({ db, tracker }, { event: "PreCompact", session_id: "CMP2" });
      const compactStop = handleHookEvent(
        { db, tracker },
        { event: "Stop", session_id: "CMP2" }
      );
      expect(compactStop.decision).toBeUndefined();

      const realStop = handleHookEvent(
        { db, tracker },
        { event: "Stop", session_id: "CMP2" }
      );
      expect(realStop.decision).toBe("block");
      expect(realStop.reason).toContain("orchestrator housekeeping");
    });

    test("R7.7: stale compacting marker (>60s old) does NOT suppress Stop", () => {
      // If a PreCompact happened long ago and was somehow not consumed (e.g.
      // compaction aborted, session reused), a normal Stop must still block.
      const { db, tracker } = freshSetup();
      const oldTs = String(Date.now() - 5 * 60_000); // 5 minutes ago
      db.run(
        `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)`,
        [`compacting_STALE`, oldTs, now()]
      );
      const stop = handleHookEvent(
        { db, tracker },
        { event: "Stop", session_id: "STALE" }
      );
      expect(stop.decision).toBe("block");
    });

    test("R7.7: PreCompact still emits its capture systemMessage", () => {
      // The marker is a side-effect; the systemMessage to the agent must
      // continue to land (it's the ONE remaining capture nudge at /compact).
      const { db, tracker } = freshSetup();
      const r = handleHookEvent(
        { db, tracker },
        { event: "PreCompact", session_id: "PC" }
      );
      expect(r.systemMessage).toContain("save_progress");
      expect(r.systemMessage).toContain("note()");
    });

    test("R7: SubagentStop prompt instructs subagent NOT to call save_progress (parent's job)", () => {
      const { db, tracker } = freshSetup();
      const r = handleHookEvent({ db, tracker }, { event: "SubagentStop", session_id: "SS" });
      expect(r.decision).toBe("block");
      // The prompt should explicitly tell the subagent not to call save_progress.
      expect(r.reason).toMatch(/Do NOT call.*save_progress/);
      expect(r.reason).toContain("note");
      expect(r.reason).toContain("close_thread");
    });

    test("R7: Stop prompt now includes loop-closure section when in-flight work_items exist", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("LC");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-1', 'work_item', 'Build R7 dispatcher', 'in_progress', 'LC', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "LC" });
      expect(r.decision).toBe("block");
      expect(r.reason).toContain("Loop-closure");
      expect(r.reason).toContain("wi-1");
    });

    test("R7: Stop prompt omits loop-closure section when no in-flight work_items exist", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("NO-LC");
      const r = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "NO-LC" });
      expect(r.reason).not.toContain("Loop-closure (R7)");
    });
  });

  describe("R7 loop-closure in UserPromptSubmit", () => {
    test("in-flight work_items in scope produce a loop-close nudge", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("U");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-x', 'work_item', 'finish R7', 'in_progress', 'U', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "UserPromptSubmit",
          session_id: "U",
          payload: { user_prompt: "what's next?" },
        }
      );
      expect(r.additionalContext).toContain("Loop-close check");
      expect(r.additionalContext).toContain("wi-x");
    });

    test("approval signal in user prompt escalates to 'Close loops NOW'", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("A");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-a', 'work_item', 'task', 'in_progress', 'A', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "UserPromptSubmit",
          session_id: "A",
          payload: { user_prompt: "looks good, ship it" },
        }
      );
      expect(r.additionalContext).toContain("User just signaled approval");
      expect(r.additionalContext).toContain("Close loops NOW");
    });

    test("R7.5: anchored regex rejects 'done' in 'everything you've done'", () => {
      // The exact false-positive Jarid hit in R7. With the tightened R7.5
      // regex, this prompt should NOT trigger the approval escalation.
      const { db, tracker } = freshSetup();
      tracker.registerSession("J");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-j', 'work_item', 'task', 'in_progress', 'J', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "UserPromptSubmit",
          session_id: "J",
          payload: { user_prompt: "want to maybe run code-reviewer over everything you've done this sesh?" },
        }
      );
      // Soft loop-close still fires (in-flight work_item exists), but NOT the strong "Close loops NOW" escalation.
      expect(r.additionalContext).toContain("Loop-close check");
      expect(r.additionalContext).not.toContain("Close loops NOW");
    });

    test("R7.5: 'thanks for trying' does not trigger approval", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("T");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-t', 'work_item', 'task', 'in_progress', 'T', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "UserPromptSubmit",
          session_id: "T",
          payload: { user_prompt: "thanks for trying but that broke things" },
        }
      );
      expect(r.additionalContext).not.toContain("Close loops NOW");
    });

    test("R7.5: 'looks good' as the whole prompt DOES trigger approval", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("OK");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-ok', 'work_item', 'task', 'in_progress', 'OK', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "UserPromptSubmit",
          session_id: "OK",
          payload: { user_prompt: "looks good!" },
        }
      );
      expect(r.additionalContext).toContain("Close loops NOW");
    });

    test("R7.5: 'lgtm' triggers approval", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("L");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-l', 'work_item', 'task', 'in_progress', 'L', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent(
        { db, tracker },
        { event: "UserPromptSubmit", session_id: "L", payload: { user_prompt: "lgtm" } }
      );
      expect(r.additionalContext).toContain("Close loops NOW");
    });

    test("R7.5: 'all done' triggers approval but bare 'done' does not", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("D");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-d', 'work_item', 'task', 'in_progress', 'D', ?, ?)`,
        [ts, ts]
      );
      const allDone = handleHookEvent(
        { db, tracker },
        { event: "UserPromptSubmit", session_id: "D", payload: { user_prompt: "all done" } }
      );
      expect(allDone.additionalContext).toContain("Close loops NOW");

      const bareDone = handleHookEvent(
        { db, tracker },
        { event: "UserPromptSubmit", session_id: "D", payload: { user_prompt: "is this done correctly?" } }
      );
      expect(bareDone.additionalContext).not.toContain("Close loops NOW");
    });

    test("long user prompt does NOT trigger approval escalation even with matching word", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("L");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-l', 'work_item', 'task', 'in_progress', 'L', ?, ?)`,
        [ts, ts]
      );
      const longPrompt = "ok " + "a very long prompt with much detail ".repeat(20) + "and looks good somewhere in here";
      expect(longPrompt.length).toBeGreaterThan(300);
      const r = handleHookEvent(
        { db, tracker },
        { event: "UserPromptSubmit", session_id: "L", payload: { user_prompt: longPrompt } }
      );
      expect(r.additionalContext).not.toContain("User just signaled approval");
      expect(r.additionalContext).toContain("Loop-close check");
    });

    test("no in-flight work_items -> no loop-close nudge regardless of user signal", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("Z");
      const r = handleHookEvent(
        { db, tracker },
        { event: "UserPromptSubmit", session_id: "Z", payload: { user_prompt: "looks good!" } }
      );
      expect(r.additionalContext).not.toContain("Loop-close");
      expect(r.additionalContext).not.toContain("Close loops NOW");
    });

    test("done work_items are NOT surfaced in loop-close", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("D");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-done', 'work_item', 'finished', 'done', 'D', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent(
        { db, tracker },
        { event: "UserPromptSubmit", session_id: "D", payload: { user_prompt: "next?" } }
      );
      expect(r.additionalContext).not.toContain("wi-done");
    });
  });

  describe("R7 sibling-overlap detection", () => {
    test("keyword overlap between user prompt and sibling task flags POTENTIAL OVERLAP", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("me");
      tracker.registerSession("sibling");
      tracker.updateCurrentTask("sibling", "refactoring authentication middleware");
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "UserPromptSubmit",
          session_id: "me",
          payload: {
            user_prompt: "let me fix the authentication flow in the middleware layer",
          },
        }
      );
      expect(r.additionalContext).toContain("POTENTIAL OVERLAP");
      // 0.29.0: send_message removed; coordinate via @SA-<id8> in terminal output.
      expect(r.additionalContext).toContain("@SA-<id8>");
    });

    test("no keyword overlap -> sibling listed without overlap marker", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("me");
      tracker.registerSession("sib");
      tracker.updateCurrentTask("sib", "writing telemetry tests");
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "UserPromptSubmit",
          session_id: "me",
          payload: { user_prompt: "let's improve the docker startup logic" },
        }
      );
      expect(r.additionalContext).not.toContain("POTENTIAL OVERLAP");
      expect(r.additionalContext).toContain("sib");
    });
  });

  describe("R7 PreToolUse code_refs hint", () => {
    test("file with extant code_refs note injects file-specific hint at turn 1", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("CR");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, code_refs, created_at, updated_at)
         VALUES ('hint-note', 'convention', 'always validate input', '["src/api.ts"]', ?, ?)`,
        [ts, ts]
      );
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "CR" });
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "PreToolUse",
          session_id: "CR",
          tool_name: "Edit",
          payload: { file_path: "src/api.ts" },
        }
      );
      expect(r.additionalContext).toContain("src/api.ts");
      expect(r.additionalContext).toContain("note");
    });

    test("code_refs hint fires only once per session per file_path", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("CR2");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, code_refs, created_at, updated_at)
         VALUES ('h1', 'convention', 'foo', '["src/x.ts"]', ?, ?)`,
        [ts, ts]
      );
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "CR2" });

      const r1 = handleHookEvent(
        { db, tracker },
        {
          event: "PreToolUse",
          session_id: "CR2",
          tool_name: "Edit",
          payload: { file_path: "src/x.ts" },
        }
      );
      const r2 = handleHookEvent(
        { db, tracker },
        {
          event: "PreToolUse",
          session_id: "CR2",
          tool_name: "Edit",
          payload: { file_path: "src/x.ts" },
        }
      );
      expect(r1.additionalContext).toContain("src/x.ts");
      // Second time: no code_refs hint (warned already, no new content).
      // additionalContext may be undefined (clean) or just NOT contain the hint.
      if (r2.additionalContext) {
        expect(r2.additionalContext).not.toContain("note");
      }
    });

    test("file with no tagged notes -> no code_refs hint", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("CR3");
      handleHookEvent({ db, tracker }, { event: "UserPromptSubmit", session_id: "CR3" });
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "PreToolUse",
          session_id: "CR3",
          tool_name: "Edit",
          payload: { file_path: "src/untagged.ts" },
        }
      );
      // Turn 1, no orch activity, would normally be silent. No hint either.
      expect(r.additionalContext).toBeUndefined();
    });
  });

  describe("R7 PostToolUse work-item drift nudge", () => {
    test("editing a file tied to in-flight work_item via code_refs surfaces it", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("WI");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, code_refs, source_session, created_at, updated_at)
         VALUES ('wi-edit', 'work_item', 'refactor api layer', 'in_progress', '["src/api.ts"]', 'WI', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "PostToolUse",
          session_id: "WI",
          tool_name: "Edit",
          payload: { file_path: "src/api.ts" },
        }
      );
      expect(r.additionalContext).toContain("wi-edit");
      expect(r.additionalContext).toContain("update_work_item");
    });

    test("drift nudge fires once per session per work_item", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("DR");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, code_refs, source_session, created_at, updated_at)
         VALUES ('wi-once', 'work_item', 'task', 'in_progress', '["src/y.ts"]', 'DR', ?, ?)`,
        [ts, ts]
      );
      const r1 = handleHookEvent(
        { db, tracker },
        {
          event: "PostToolUse",
          session_id: "DR",
          tool_name: "Edit",
          payload: { file_path: "src/y.ts" },
        }
      );
      const r2 = handleHookEvent(
        { db, tracker },
        {
          event: "PostToolUse",
          session_id: "DR",
          tool_name: "Edit",
          payload: { file_path: "src/y.ts" },
        }
      );
      expect(r1.additionalContext).toContain("wi-once");
      // r2 may be empty or have other content but not the same nudge.
      if (r2.additionalContext) {
        expect(r2.additionalContext).not.toContain("wi-once");
      }
    });

    test("done work_item does NOT trigger drift nudge", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("DN");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, code_refs, source_session, created_at, updated_at)
         VALUES ('wi-d', 'work_item', 'shipped', 'done', '["src/z.ts"]', 'DN', ?, ?)`,
        [ts, ts]
      );
      const r = handleHookEvent(
        { db, tracker },
        {
          event: "PostToolUse",
          session_id: "DN",
          tool_name: "Edit",
          payload: { file_path: "src/z.ts" },
        }
      );
      expect(r.additionalContext).toBeUndefined();
    });
  });

  describe("R7 TaskCompleted hook", () => {
    test("emits a capture nudge with the subagent id", () => {
      const { db, tracker } = freshSetup();
      const r = handleHookEvent(
        { db, tracker },
        { event: "TaskCompleted", session_id: "T", agent_id: "abcd1234efghij" }
      );
      expect(r.additionalContext).toContain("abcd1234");
      expect(r.additionalContext).toContain("capture");
    });

    test("falls back to 'subagent' label when agent_id is missing", () => {
      const { db, tracker } = freshSetup();
      const r = handleHookEvent(
        { db, tracker },
        { event: "TaskCompleted", session_id: "T2" }
      );
      expect(r.additionalContext).toContain("subagent");
    });
  });

  describe("R7 StopFailure hook", () => {
    test("emits a systemMessage on API-error stop without blocking", () => {
      const { db, tracker } = freshSetup();
      const r = handleHookEvent({ db, tracker }, { event: "StopFailure", session_id: "F" });
      expect(r.systemMessage).toBeDefined();
      expect(r.systemMessage).toContain("API error");
      expect(r.decision).toBeUndefined();
    });
  });

  // 167ffbaf (+ e4774e4b): post-compaction SessionStart hook. Fires only via
  // hooks.json `matcher:"compact"` (the universal SessionStart stays bash).
  // Delivers a bounded re-orientation digest as a top-level systemMessage
  // (NOT hookSpecificOutput - SessionStart is not an HSO-valid event name;
  // verified against hook_envelope.test.ts ALLOWED_HSO_EVENT_NAMES) plus,
  // when a live PA exists, an instruction to solicit a peer backstop.
  describe("SessionStart (post-compact re-orientation)", () => {
    function seedCheckpoint(db: any, content: string) {
      db.run(
        `INSERT INTO notes (id, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        ["cp-compact", "checkpoint", content, now(), now()]
      );
    }

    // --- Pure composer: livePA branches tested deterministically (the
    //     handler's getLiveSessions() is a non-hermetic disk read - it
    //     reflects the REAL running fleet - so the live branch is covered
    //     here, not through the impure shell). ---

    test("composer: NO live PA → omits the @PA peer-backstop directive, keeps self-restore", () => {
      const msg = composePostCompactReorientation({
        currentTask: "task two",
        checkpoint: "checkpoint body two",
        livePA: false,
      });
      expect(msg.toLowerCase()).toContain("compact");
      expect(msg).toContain("task two");
      expect(msg).toContain("checkpoint body two");
      expect(msg).not.toContain("[post-compact recovery]");
    });

    test("composer: live PA → includes the one-shot @PA peer-backstop solicitation", () => {
      const msg = composePostCompactReorientation({
        currentTask: "wiring the post-compact hook",
        checkpoint: "cp body",
        livePA: true,
      });
      expect(msg).toContain("[post-compact recovery]");
      expect(msg).toContain("wiring the post-compact hook");
      expect(msg.toLowerCase()).toContain("non-blocking");
    });

    test("composer: huge checkpoint capped with an honest truncation marker, bounded total", () => {
      const msg = composePostCompactReorientation({
        currentTask: null,
        checkpoint: "HEAD " + "x".repeat(60_000) + " TAIL",
        livePA: false,
      });
      expect(msg.length).toBeLessThanOrEqual(8000);
      expect(msg.toLowerCase()).toContain("truncated");
    });

    test("composer: no checkpoint → sane re-orient, no literal undefined/null", () => {
      const msg = composePostCompactReorientation({
        currentTask: "task four",
        checkpoint: null,
        livePA: false,
      });
      expect(msg.toLowerCase()).toContain("compact");
      expect(msg).toContain("task four");
      expect(msg).not.toContain("undefined");
      expect(msg).not.toContain("null");
    });

    // --- Handler: hermetic integration (DB digest + non-HSO envelope shape).
    //     No livePA-dependent assertion here (that'd depend on the real
    //     fleet); the HSO-trap guard is environment-independent. ---

    test("handler: top-level systemMessage from DB state; NOT additionalContext; envelope has NO hookSpecificOutput (SessionStart-not-HSO guard)", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("SC1");
      tracker.updateCurrentTask("SC1", "wiring the post-compact hook");
      seedCheckpoint(db, "Last state: implemented X, next is Y, open question Z.");

      const r = handleHookEvent(
        { db, tracker },
        { event: "SessionStart", session_id: "SC1" }
      );

      expect(r.systemMessage).toBeDefined();
      expect(r.systemMessage!.toLowerCase()).toContain("compact");
      expect(r.systemMessage).toContain("wiring the post-compact hook");
      expect(r.systemMessage).toContain("implemented X, next is Y");
      expect(r.additionalContext).toBeUndefined();
      const env = buildHookEnvelope("SessionStart", r);
      expect(env.systemMessage).toBeDefined();
      expect(env.hookSpecificOutput).toBeUndefined();
    });

    test("handler: no checkpoint and no task → still a sane non-empty systemMessage (no crash)", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("SC5");

      const r = handleHookEvent(
        { db, tracker },
        { event: "SessionStart", session_id: "SC5" }
      );

      expect(r.systemMessage).toBeDefined();
      expect(r.systemMessage!.toLowerCase()).toContain("compact");
      expect(r.systemMessage).not.toContain("undefined");
    });
  });
});

// 167ffbaf-xs regression. The `_hook_event` MCP tool's RUNTIME Zod `event`
// enum (server.ts) and the COMPILE-TIME HookEvent type must stay in sync
// with the dispatcher switch + hooks.json. They drifted in 0.30.41 and
// earlier: the Zod enum was hand-maintained separately and never got
// "SessionStart" when 167ffbaf added it everywhere else. Live consequence:
// CC's SessionStart `matcher:"compact"` hook was rejected
// `-32602 Invalid arguments for tool _hook_event` AT THE MCP BOUNDARY, the
// dispatcher never ran, and post-compact re-orientation silently never
// surfaced. The pre-existing "SessionStart (post-compact re-orientation)"
// tests pass even WITH the bug because they call handleHookEvent()
// directly and never cross the Zod schema. These boundary-crossing tests
// are the ones that would have caught it; both surfaces now derive from
// the single source HOOK_EVENTS so the class of drift is structurally
// impossible.
describe("_hook_event boundary: HOOK_EVENTS <-> Zod schema <-> dispatcher parity (167ffbaf-xs)", () => {
  // Reconstructs the EXACT expression server.ts uses for the tool's
  // `event` validator, against the same imported single-source array.
  const EventEnum = z.enum(HOOK_EVENTS);

  test("the runtime Zod enum accepts every HookEvent - explicitly including SessionStart", () => {
    expect(HOOK_EVENTS).toContain("SessionStart");
    for (const e of HOOK_EVENTS) {
      expect(() => EventEnum.parse(e)).not.toThrow();
    }
  });

  test("SessionStart parses at the boundary (the exact 0.30.41 -32602 failure)", () => {
    // Pre-fix this threw a ZodError, which MCP surfaced to Claude Code as
    // `-32602 Invalid arguments for tool _hook_event`.
    expect(EventEnum.parse("SessionStart")).toBe("SessionStart");
  });

  test("every HOOK_EVENTS member is handled by the dispatcher without throwing", () => {
    for (const e of HOOK_EVENTS) {
      const { db, tracker } = freshSetup();
      expect(() =>
        handleHookEvent({ db, tracker }, { event: e, session_id: `parity-${e}` })
      ).not.toThrow();
    }
  });

  test("an event NOT in HOOK_EVENTS is rejected by the boundary validator", () => {
    expect(() => EventEnum.parse("NotARealEvent")).toThrow();
  });
});
