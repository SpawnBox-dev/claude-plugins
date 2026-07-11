import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { applyMigrations } from "../../mcp/db/schema";
import { SessionTracker } from "../../mcp/engine/session_tracker";
import {
  handleHookEvent,
  buildHookEnvelope,
  composePostCompactReorientation,
  composePrecompactSnapshot,
  buildPeerBackstopEvent,
  buildPaCompactAdvisoryEvent,
  POST_COMPACT_RECOVERY_EVENT,
  PA_COMPACT_RECOVERY_EVENT,
  HOOK_EVENTS,
  type HookEventResponse,
} from "../../mcp/tools/hook_event";
import { now } from "../../mcp/utils";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TEST HERMETICITY (anti_pattern 2fe2e609 / WI per that note): the SessionStart
// compact handler emits a real post_compact_recovery row via
// appendSystemEvent(getAgentChannelStateDir(), ...). getAgentChannelStateDir()
// resolves ORCHESTRATOR_PROJECT_ROOT || CLAUDE_PROJECT_DIR || cwd; left
// unisolated it hits the REAL project agent-channel DB and leaks fake
// pa_addressed advisories onto the LIVE channel (PA-observed 2026-05-18:
// synthetic sessions SC1/SC5/parity-* reaching the live PA). Point the suite's
// project root at an empty temp dir so getAgentChannelStateDir() finds no
// .orchestrator-state and returns null -> the compact handler skips the emit.
// Production-zero (test env only); matches this file's existing hermetic
// intent ("no livePA-dependent assertion - that'd depend on the real fleet").
process.env.ORCHESTRATOR_PROJECT_ROOT = mkdtempSync(
  join(tmpdir(), "hookevt-iso-"),
);

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
      // WI 2ad3240e (Jarid override): PreCompact returns NO systemMessage now
      // (the marker + synthetic bank are pure side effects). The Stop
      // suppression must still work off the marker.
      expect(pre.systemMessage).toBeUndefined();
      const marker = db
        .query(`SELECT value FROM plugin_state WHERE key = 'compacting_CMP'`)
        .get();
      expect(marker).not.toBeNull();

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

    test("WI 2ad3240e: PreCompact returns NO systemMessage (dead non-actionable + post-compaction-harmful prompt removed)", () => {
      // The former "capture NOW via save_progress" prompt is DELETED, not
      // softened (Jarid override 2026-07-11). PreCompact has no model turn
      // before compaction, so any systemMessage it returns can only reach the
      // model post-compaction, where "save_progress now" would checkpoint the
      // already-degraded context. Capture is handled deterministically by the
      // synthetic snapshot bank + the cadence nudge instead.
      const { db, tracker } = freshSetup();
      const r = handleHookEvent(
        { db, tracker },
        { event: "PreCompact", session_id: "PC" }
      );
      expect(r.systemMessage).toBeUndefined();
      expect(r.decision).toBeUndefined();
      expect(r.additionalContext).toBeUndefined();
      // The envelope is the empty fast-path (zero token cost).
      const env = buildHookEnvelope("PreCompact", r);
      expect(env.systemMessage).toBeUndefined();
      expect(env.hookSpecificOutput).toBeUndefined();
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

    test("composer: NO live PA → no peer-backstop mention at all, keeps self-restore", () => {
      const msg = composePostCompactReorientation({
        currentTask: "task two",
        checkpoint: "checkpoint body two",
        livePA: false,
      });
      expect(msg.toLowerCase()).toContain("compact");
      expect(msg).toContain("task two");
      expect(msg).toContain("checkpoint body two");
      expect(msg.toLowerCase()).not.toContain("peer-backstop");
      expect(msg.toLowerCase()).not.toContain("post-compact recovery");
    });

    test("composer: live PA → INFORMS that the backstop was auto-emitted on the agent's behalf; never instructs the agent to post (5d1c20fc trigger-design fix)", () => {
      const msg = composePostCompactReorientation({
        currentTask: "wiring the post-compact hook",
        checkpoint: "cp body",
        livePA: true,
      });
      // Informed it happened automatically...
      expect(msg.toLowerCase()).toContain("on your behalf");
      expect(msg.toLowerCase()).toContain("automatically");
      expect(msg.toLowerCase()).toContain("non-blocking");
      // ...and explicitly NOT asked to post the line itself - the exact
      // soft-compliance ask the 5d1c20fc live evidence proved fails.
      expect(msg).not.toContain("post ONE line");
      expect(msg.toLowerCase()).toContain("do not need to post");
    });

    test("buildPeerBackstopEvent: live PA → well-formed post_compact_recovery row, from compacted SA to PA", () => {
      const ev = buildPeerBackstopEvent({
        fromSession: "sa-uuid",
        paSession: "pa-uuid",
        currentTask: "doing the thing",
        ts: "2026-05-18T07:00:00.000Z",
      });
      expect(ev).not.toBeNull();
      expect(ev!.event_type).toBe(POST_COMPACT_RECOVERY_EVENT);
      expect(ev!.event_type).toBe("post_compact_recovery");
      expect(ev!.from_session).toBe("sa-uuid");
      expect(ev!.to_session).toBe("pa-uuid");
      expect(ev!.ts).toBe("2026-05-18T07:00:00.000Z");
      expect(ev!.task).toBe("doing the thing");
    });

    test("buildPeerBackstopEvent: no live PA → null (no oracle/router to solicit)", () => {
      expect(
        buildPeerBackstopEvent({
          fromSession: "sa-uuid",
          paSession: null,
          currentTask: "x",
          ts: "t",
        })
      ).toBeNull();
    });

    test("buildPeerBackstopEvent: PA itself compacted (pa===from) → null (PA-self-backstop out of e4774e4b scope)", () => {
      expect(
        buildPeerBackstopEvent({
          fromSession: "pa-uuid",
          paSession: "pa-uuid",
          currentTask: "x",
          ts: "t",
        })
      ).toBeNull();
    });

    test("buildPeerBackstopEvent: null currentTask → coerced to empty string, still a valid event", () => {
      const ev = buildPeerBackstopEvent({
        fromSession: "sa-uuid",
        paSession: "pa-uuid",
        currentTask: null,
        ts: "t",
      });
      expect(ev).not.toBeNull();
      expect(ev!.task).toBe("");
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

    test("composer: currentTask is hedged as possibly-stale, not asserted authoritatively (167ffbaf-xs cosmetic follow-up)", () => {
      const msg = composePostCompactReorientation({
        currentTask: "an old stale probe task",
        checkpoint: "fresh checkpoint body",
        livePA: false,
      });
      // The task value is still surfaced (it's a useful pointer)...
      expect(msg).toContain("an old stale probe task");
      // ...but NOT as a bald authoritative "Your task: X" assertion - the
      // post-compact moment is the worst time to feed a stale task as fact.
      expect(msg).not.toContain("Your task: an old stale probe task");
      expect(msg.toLowerCase()).toContain("stale");
      expect(msg.toLowerCase()).toMatch(/reconcile|verify/);
    });

    // WI 2da3e119: the post-compact re-orientation must re-establish HOW TO
    // OPERATE (the behavioral contract compaction summaries drop), not only
    // WHAT (task/checkpoint). Deterministic in the emitted systemMessage -
    // the just-compacted agent demonstrably skips the terse re-injected
    // "invoke getting-started/every-turn" directive (e4774e4b/5d1c20fc class).
    test("composer: re-establishes the distilled OPERATING CONTRACT (how-to-operate), not just state (WI 2da3e119)", () => {
      const msg = composePostCompactReorientation({
        currentTask: "some task",
        checkpoint: "some checkpoint body",
        livePA: false,
      });
      const lc = msg.toLowerCase();
      // (1) every-turn loop is the keystone reflex, mandated explicitly
      expect(lc).toContain("every-turn");
      // (2) capture-the-moment, never defer, never .md-memory-substitute
      expect(lc).toMatch(/capture .*(the moment|now)|never defer|capture later/);
      expect(lc).toContain("note()");
      // (3) verify-before-assert: WAS vs IS
      expect(lc).toContain("what was");
      expect(lc).toContain("what is");
      // (4) messaging discipline + no-false-close
      expect(lc).toContain("trap-safe");
      expect(lc).toContain("no-false-close");
      // (5) reload role contract; do not infer from the lossy summary
      expect(lc).toMatch(/role contract|reload it|getting-started/);
      // framed as not-optional / likely-degraded (counters the skip)
      expect(lc).toMatch(/not optional|degraded|drops these/);
      // does not regress the existing state content
      expect(msg).toContain("some task");
      expect(msg).toContain("some checkpoint body");
    });

    test("composer: operating-contract survives a huge checkpoint - it is budget-protected; the checkpoint is the elastic, lookup-recoverable part (WI 2da3e119)", () => {
      const msg = composePostCompactReorientation({
        currentTask: "t",
        checkpoint: "HEAD " + "x".repeat(60_000) + " TAIL",
        livePA: true,
      });
      // The load-bearing operating-contract is NOT what gets truncated:
      expect(msg.toLowerCase()).toContain("every-turn");
      expect(msg.toLowerCase()).toContain("no-false-close");
      // still bounded, honest truncation marker present (checkpoint yielded)
      expect(msg.length).toBeLessThanOrEqual(8000);
      expect(msg.toLowerCase()).toContain("truncated");
      // livePA peer-backstop inform line not clobbered by the OC addition
      expect(msg.toLowerCase()).toContain("on your behalf");
    });

    // WI 9c01fb36: a compacted PA must be told to rehydrate from its
    // context-warden's ledger FIRST (the warden is PA's striped context
    // redundancy). PA-branch only; an SA has no warden.
    test("composer: PA branch tells the compacted PA to rehydrate from its context-warden FIRST; SA branch does not", () => {
      const paMsg = composePostCompactReorientation({
        currentTask: "orchestrating the fleet",
        checkpoint: "cp body",
        livePA: false,
        role: "prime",
        peers: [],
      });
      expect(paMsg.toLowerCase()).toContain("context-warden");
      expect(paMsg.toLowerCase()).toContain("ledger");

      const saMsg = composePostCompactReorientation({
        currentTask: "an SA task",
        checkpoint: "cp",
        livePA: true,
        role: "subordinate",
        peers: [],
      });
      expect(saMsg.toLowerCase()).not.toContain("context-warden");
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

    // WI 2ad3240e review (P2, SA-0c230dcf): the no-fresh-synthetic fallback must
    // prefer THIS session's own latest checkpoint over another session's newer
    // one - otherwise the cross-session shadow the change claims to fix reappears
    // in the degraded path. notes.source_session provides the attribution.
    test("handler: post-compact fallback prefers THIS session's own checkpoint over another session's newer one", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("SCme");
      // This session's OWN checkpoint (older).
      db.run(
        `INSERT INTO notes (id, type, content, source_session, created_at, updated_at) VALUES (?, 'checkpoint', ?, ?, ?, ?)`,
        ["cp-mine", "MY-OWN-STATE: implemented the widget", "SCme", "2026-07-11T10:00:00.000Z", "2026-07-11T10:00:00.000Z"]
      );
      // Another session's NEWER checkpoint (wins a naive global-latest ORDER BY).
      db.run(
        `INSERT INTO notes (id, type, content, source_session, created_at, updated_at) VALUES (?, 'checkpoint', ?, ?, ?, ?)`,
        ["cp-other", "OTHER-SESSION-STATE: unrelated work", "SCother", "2026-07-11T18:00:00.000Z", "2026-07-11T18:00:00.000Z"]
      );

      const r = handleHookEvent(
        { db, tracker },
        { event: "SessionStart", session_id: "SCme" }
      );

      expect(r.systemMessage).toBeDefined();
      expect(r.systemMessage).toContain("MY-OWN-STATE");
      expect(r.systemMessage).not.toContain("OTHER-SESSION-STATE");
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

// WI 2ad3240e: role-aware + symmetric post-compact recovery. When the
// compacted agent is the PA the guidance becomes a FLEET CHECK-IN + the hook
// deterministically advises every SA; when it's an SA the existing PA-backstop
// is kept and augmented with a proactive check-in + a bounded lateral roster.
// PreCompact capture is made deterministic (synthetic snapshot) because the
// pre-compact model turn cannot run tools. Pure composers/builders carry the
// coverage; the impure getLiveSessions()/appendSystemEvent() glue stays
// untested-for-live (same convention as e4774e4b).
describe("WI 2ad3240e: role-aware symmetric post-compact recovery", () => {
  describe("composer - PA (prime) branch", () => {
    test("prime: FLEET CHECK-IN directive + roster of SAs to poll; PA is the backstop SOURCE, never told to 'check in with PA'", () => {
      const msg = composePostCompactReorientation({
        role: "prime",
        currentTask: "orchestrating the fleet",
        checkpoint: "pa checkpoint body",
        livePA: false,
        peers: [
          { id8: "aaaaaaaa", current_task: "backend lows sweep" },
          { id8: "bbbbbbbb", current_task: null },
        ],
      });
      const lc = msg.toLowerCase();
      expect(lc).toContain("fleet check-in");
      expect(lc).toContain("poll every active subordinate");
      // (b) recent completions WITH ids requested
      expect(lc).toContain("recent completions");
      // roster with both SAs; null task rendered safely
      expect(msg).toContain("SA-aaaaaaaa: backend lows sweep");
      expect(msg).toContain("SA-bbbbbbbb: (no task set)");
      expect(msg).not.toContain("null");
      expect(msg).not.toContain("undefined");
      // PA is the source of the advisory, not a recipient of "check in with PA"
      expect(lc).not.toContain("check in with pa");
      // informs PA the SA advisories were auto-emitted on its behalf
      expect(lc).toContain("on your behalf");
      // still carries the state
      expect(msg).toContain("orchestrating the fleet");
      expect(msg).toContain("pa checkpoint body");
    });

    test("prime: high-loss-zone warning present (requirement 3, both directions)", () => {
      const msg = composePostCompactReorientation({
        role: "prime",
        currentTask: "t",
        checkpoint: null,
        livePA: false,
        peers: [],
      });
      const lc = msg.toLowerCase();
      expect(lc).toContain("highest-loss zone");
      expect(lc).toContain("already"); // "already DONE"
      expect(lc).toContain("stale queue");
    });
  });

  describe("composer - SA (subordinate) branch additions", () => {
    test("subordinate + livePA: proactive CHECK IN with PA + lateral roster, keeps the passive backstop inform (5d1c20fc)", () => {
      const msg = composePostCompactReorientation({
        role: "subordinate",
        currentTask: "fixing the DNS lease reaper",
        checkpoint: "cp",
        livePA: true,
        peers: [{ id8: "cccccccc", current_task: "writing telemetry tests" }],
      });
      const lc = msg.toLowerCase();
      // passive backstop inform preserved
      expect(lc).toContain("on your behalf");
      expect(lc).toContain("do not need to post");
      expect(lc).toContain("non-blocking");
      expect(msg).not.toContain("post ONE line");
      // NEW (req 2a): proactive check-in with PA
      expect(lc).toContain("check in with pa");
      // NEW (req 2b): bounded lateral roster with @SA addressing
      expect(msg).toContain("SA-cccccccc: writing telemetry tests");
      expect(lc).toContain("@sa-<id8>");
      // req 3 high-loss-zone
      expect(lc).toContain("highest-loss zone");
    });

    test("subordinate + NO livePA: no check-in-with-PA and no peer-backstop wording, but lateral roster still shows for peer coordination + high-loss-zone present", () => {
      const msg = composePostCompactReorientation({
        role: "subordinate",
        currentTask: "solo-ish work",
        checkpoint: "cp",
        livePA: false,
        peers: [{ id8: "dddddddd", current_task: "map pipeline" }],
      });
      const lc = msg.toLowerCase();
      expect(lc).not.toContain("check in with pa");
      expect(lc).not.toContain("on your behalf");
      expect(lc).not.toContain("peer-backstop");
      // req 2b: roster is gated on peers, not livePA - lateral comms survive
      expect(msg).toContain("SA-dddddddd: map pipeline");
      expect(lc).toContain("highest-loss zone");
    });

    test("subordinate with no peers and no PA: clean solo digest, no roster, no undefined/null (backward-compatible default)", () => {
      const msg = composePostCompactReorientation({
        role: "subordinate",
        currentTask: "solo",
        checkpoint: "cp",
        livePA: false,
        peers: [],
      });
      expect(msg).not.toContain("Other active subordinates");
      expect(msg).not.toContain("undefined");
      expect(msg).not.toContain("null");
      expect(msg.toLowerCase()).toContain("highest-loss zone");
    });

    test("roster is bounded: >8 peers truncate with an 'and N more' marker", () => {
      const peers = Array.from({ length: 11 }, (_, i) => ({
        id8: `id${i}`.padEnd(8, "0"),
        current_task: `task ${i}`,
      }));
      const msg = composePostCompactReorientation({
        role: "prime",
        currentTask: "t",
        checkpoint: null,
        livePA: false,
        peers,
      });
      expect(msg).toContain("and 3 more"); // 11 - 8 shown
    });

    test("roster truncates long task lines to the cap", () => {
      const longTask = "x".repeat(200);
      const msg = composePostCompactReorientation({
        role: "prime",
        currentTask: "t",
        checkpoint: null,
        livePA: false,
        peers: [{ id8: "eeeeeeee", current_task: longTask }],
      });
      // 70-char cap on the task slice - the full 200-char line must NOT appear
      expect(msg).not.toContain(longTask);
      expect(msg).toContain("SA-eeeeeeee: " + "x".repeat(70));
    });
  });

  describe("buildPaCompactAdvisoryEvent (PA -> each SA)", () => {
    test("well-formed pa_compact_recovery row from PA to an SA", () => {
      const ev = buildPaCompactAdvisoryEvent({
        fromSession: "pa-uuid",
        toSession: "sa-uuid",
        currentTask: "orchestrating",
        ts: "2026-07-11T07:00:00.000Z",
      });
      expect(ev).not.toBeNull();
      expect(ev!.event_type).toBe(PA_COMPACT_RECOVERY_EVENT);
      expect(ev!.event_type).toBe("pa_compact_recovery");
      expect(ev!.from_session).toBe("pa-uuid");
      expect(ev!.to_session).toBe("sa-uuid");
      expect(ev!.ts).toBe("2026-07-11T07:00:00.000Z");
      expect(ev!.task).toBe("orchestrating");
    });

    test("null currentTask coerced to empty string, still valid", () => {
      const ev = buildPaCompactAdvisoryEvent({
        fromSession: "pa-uuid",
        toSession: "sa-uuid",
        currentTask: null,
        ts: "t",
      });
      expect(ev).not.toBeNull();
      expect(ev!.task).toBe("");
    });

    test("self-addressed (from === to) returns null - never advise yourself", () => {
      expect(
        buildPaCompactAdvisoryEvent({
          fromSession: "same",
          toSession: "same",
          currentTask: "x",
          ts: "t",
        })
      ).toBeNull();
    });

    test("empty from/to returns null", () => {
      expect(
        buildPaCompactAdvisoryEvent({
          fromSession: "",
          toSession: "sa",
          currentTask: "x",
          ts: "t",
        })
      ).toBeNull();
      expect(
        buildPaCompactAdvisoryEvent({
          fromSession: "pa",
          toSession: "",
          currentTask: "x",
          ts: "t",
        })
      ).toBeNull();
    });
  });

  describe("composePrecompactSnapshot (deterministic pre-compact capture)", () => {
    test("includes task + work_items + recent notes as bounded pointers", () => {
      const text = composePrecompactSnapshot({
        currentTask: "wire the recovery hook",
        recentNotes: [
          { id: "note1234abcd", type: "decision", snippet: "went with X over Y" },
          { id: "note5678efgh", type: "gotcha", snippet: "beware the Z race" },
        ],
        workItems: [
          { id: "wiabcdef00", status: "in_progress", content: "build the thing" },
        ],
        ts: "2026-07-11T07:00:00.000Z",
      });
      expect(text).toContain("Auto-captured");
      expect(text).toContain("wire the recovery hook");
      expect(text).toContain("wiabcdef"); // work_item id8
      expect(text).toContain("build the thing");
      expect(text).toContain("note1234"); // note id8
      expect(text).toContain("went with X over Y");
      expect(text).toContain("2026-07-11T07:00:00.000Z");
    });

    test("null task and empty notes/work_items -> safe reconstruct prompt, no literal null/undefined", () => {
      const text = composePrecompactSnapshot({
        currentTask: null,
        recentNotes: [],
        workItems: [],
        ts: "t",
      });
      expect(text).toContain("(none set)");
      expect(text.toLowerCase()).toContain("reconstruct");
      expect(text).not.toContain("undefined");
      // no bare "null" token
      expect(text).not.toMatch(/\bnull\b/);
    });

    test("bounded: a huge work_item list is truncated under the snapshot cap", () => {
      const workItems = Array.from({ length: 50 }, (_, i) => ({
        id: `wi${i}`.padEnd(8, "0"),
        status: "in_progress",
        content: "y".repeat(300),
      }));
      const text = composePrecompactSnapshot({
        currentTask: "t",
        recentNotes: [],
        workItems,
        ts: "t",
      });
      // Well under the composer's 4000 checkpoint cap so it surfaces whole.
      expect(text.length).toBeLessThanOrEqual(3600);
    });
  });

  describe("handlePreCompact - deterministic snapshot bank", () => {
    test("banks a synthetic checkpoint into plugin_state, keeps the Stop-suppression marker, and returns NO systemMessage", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("PCB");
      tracker.updateCurrentTask("PCB", "banked task");
      const ts = now();
      // Seed an in-flight work_item + a recent note for this session.
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-pcb', 'work_item', 'the in-flight thing', 'in_progress', 'PCB', ?, ?)`,
        [ts, ts]
      );
      db.run(
        `INSERT INTO notes (id, type, content, source_session, created_at, updated_at)
         VALUES ('note-pcb', 'decision', 'a fresh decision', 'PCB', ?, ?)`,
        [ts, ts]
      );

      const r = handleHookEvent(
        { db, tracker },
        { event: "PreCompact", session_id: "PCB" }
      );
      // No systemMessage - the dead prompt is gone; capture is the side effect.
      expect(r.systemMessage).toBeUndefined();

      // Stop-suppression marker preserved (numeric epoch ms).
      const marker = db
        .query(`SELECT value FROM plugin_state WHERE key = 'compacting_PCB'`)
        .get() as { value: string } | null;
      expect(marker).not.toBeNull();
      expect(Number.isFinite(parseInt(marker!.value, 10))).toBe(true);

      // Synthetic snapshot banked as JSON {text, ts}.
      const snap = db
        .query(`SELECT value FROM plugin_state WHERE key = 'precompact_cp_PCB'`)
        .get() as { value: string } | null;
      expect(snap).not.toBeNull();
      const parsed = JSON.parse(snap!.value);
      expect(typeof parsed.text).toBe("string");
      expect(typeof parsed.ts).toBe("string");
      expect(parsed.text).toContain("banked task");
      expect(parsed.text).toContain("the in-flight thing");
      expect(parsed.text).toContain("a fresh decision");
    });
  });

  describe("handleSessionStartCompact - synthetic snapshot is first-class", () => {
    test("a FRESH synthetic snapshot is preferred outright, even when a real checkpoint note exists (first-class, not a fallback)", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("FRSH");
      // A real (possibly cross-session) checkpoint note.
      db.run(
        `INSERT INTO notes (id, type, content, created_at, updated_at) VALUES ('cp-any', 'checkpoint', 'SOME REAL CHECKPOINT', ?, ?)`,
        [now(), now()]
      );
      // A synthetic snapshot banked NOW (fresh) -> wins regardless.
      db.run(
        `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES ('precompact_cp_FRSH', ?, ?)`,
        [JSON.stringify({ text: "SYNTHETIC FRESH SNAPSHOT", ts: now() }), now()]
      );
      const r = handleHookEvent(
        { db, tracker },
        { event: "SessionStart", session_id: "FRSH" }
      );
      expect(r.systemMessage).toContain("SYNTHETIC FRESH SNAPSHOT");
      expect(r.systemMessage).not.toContain("SOME REAL CHECKPOINT");
    });

    test("a STALE synthetic snapshot (banked >30min ago) is NOT used; the real checkpoint fallback wins (lingering-snapshot guard)", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("STALESYN");
      db.run(
        `INSERT INTO notes (id, type, content, created_at, updated_at) VALUES ('cp-fallback', 'checkpoint', 'REAL FALLBACK CHECKPOINT', ?, ?)`,
        [now(), now()]
      );
      const stale = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago
      db.run(
        `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES ('precompact_cp_STALESYN', ?, ?)`,
        [JSON.stringify({ text: "STALE SYNTHETIC SNAPSHOT", ts: stale }), stale]
      );
      const r = handleHookEvent(
        { db, tracker },
        { event: "SessionStart", session_id: "STALESYN" }
      );
      expect(r.systemMessage).toContain("REAL FALLBACK CHECKPOINT");
      expect(r.systemMessage).not.toContain("STALE SYNTHETIC SNAPSHOT");
    });

    test("no synthetic at all -> falls back to the latest real checkpoint note", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("NOSYN");
      db.run(
        `INSERT INTO notes (id, type, content, created_at, updated_at) VALUES ('cp-only', 'checkpoint', 'ONLY REAL CHECKPOINT', ?, ?)`,
        [now(), now()]
      );
      const r = handleHookEvent(
        { db, tracker },
        { event: "SessionStart", session_id: "NOSYN" }
      );
      expect(r.systemMessage).toContain("ONLY REAL CHECKPOINT");
    });

    test("no real checkpoint and a fresh synthetic -> synthetic fills the digest (never the empty 'No durable checkpoint' branch)", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("SYNONLY");
      db.run(
        `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES ('precompact_cp_SYNONLY', ?, ?)`,
        [JSON.stringify({ text: "ONLY SYNTHETIC AVAILABLE", ts: now() }), now()]
      );
      const r = handleHookEvent(
        { db, tracker },
        { event: "SessionStart", session_id: "SYNONLY" }
      );
      expect(r.systemMessage).toContain("ONLY SYNTHETIC AVAILABLE");
      expect(r.systemMessage).not.toContain("No durable checkpoint found");
    });

    test("end-to-end: PreCompact bank then SessionStart surfaces the banked snapshot (deterministic capture, no agent action)", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("E2E");
      tracker.updateCurrentTask("E2E", "e2e task");
      const ts = now();
      db.run(
        `INSERT INTO notes (id, type, content, status, source_session, created_at, updated_at)
         VALUES ('wi-e2e', 'work_item', 'e2e work item', 'in_progress', 'E2E', ?, ?)`,
        [ts, ts]
      );
      // Agent takes NO capture action - only the hooks fire.
      handleHookEvent({ db, tracker }, { event: "PreCompact", session_id: "E2E" });
      const r = handleHookEvent(
        { db, tracker },
        { event: "SessionStart", session_id: "E2E" }
      );
      expect(r.systemMessage).toContain("e2e task");
      expect(r.systemMessage).toContain("e2e work item");
      expect(r.systemMessage).not.toContain("No durable checkpoint found");
    });
  });

  describe("RAID framing (peers as striped redundancy) in both payloads", () => {
    test("both PA and SA post-compact payloads frame warm peers as striped redundancy", () => {
      const pa = composePostCompactReorientation({
        role: "prime",
        currentTask: "t",
        checkpoint: null,
        livePA: false,
        peers: [{ id8: "aaaaaaaa", current_task: "x" }],
      });
      const sa = composePostCompactReorientation({
        role: "subordinate",
        currentTask: "t",
        checkpoint: null,
        livePA: true,
        peers: [{ id8: "bbbbbbbb", current_task: "y" }],
      });
      expect(pa.toLowerCase()).toContain("raid");
      expect(pa.toLowerCase()).toContain("striped redundancy");
      expect(sa.toLowerCase()).toContain("raid");
      expect(sa.toLowerCase()).toContain("striped redundancy");
    });
  });

  describe("regular-checkpoint cadence nudge (UserPromptSubmit)", () => {
    // Helper: one turn = a UserPromptSubmit followed by a substantive PostToolUse.
    function workTurn(
      db: any,
      tracker: any,
      sid: string,
      tool = "Edit"
    ): HookEventResponse {
      const r = handleHookEvent(
        { db, tracker },
        { event: "UserPromptSubmit", session_id: sid, payload: { user_prompt: "w" } }
      );
      handleHookEvent(
        { db, tracker },
        { event: "PostToolUse", session_id: sid, tool_name: tool, payload: { file_path: "f.ts" } }
      );
      return r;
    }

    test("stays silent until BOTH turns-since-save and activity cross the SA bar, then fires level-0 wording", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("CAD");
      // Turn 6 / activity 5 clears the PA pre-gate but not the SA bar (10/12).
      let r: HookEventResponse = {};
      for (let i = 0; i < 9; i++) r = workTurn(db, tracker, "CAD");
      // After 9 work-turns: turn 9, activity 8 (from 8 prior edits) - still silent.
      expect(r.additionalContext ?? "").not.toContain("Checkpoint hygiene");
      // Push through the SA bar (turn>=10 AND activity>=12).
      let last: HookEventResponse = {};
      for (let i = 0; i < 4; i++) last = workTurn(db, tracker, "CAD");
      expect(last.additionalContext).toContain("Checkpoint hygiene");
      expect(last.additionalContext).toContain("save_progress");
    });

    test("read-only / lookup turns never accrue cadence activity (no nudge across many turns)", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("RO");
      let last: HookEventResponse = {};
      for (let i = 0; i < 20; i++) {
        last = handleHookEvent(
          { db, tracker },
          { event: "UserPromptSubmit", session_id: "RO", payload: { user_prompt: "w" } }
        );
        handleHookEvent({ db, tracker }, { event: "PostToolUse", session_id: "RO", tool_name: "Read" });
        handleHookEvent(
          { db, tracker },
          { event: "PostToolUse", session_id: "RO", tool_name: "mcp__plugin_orchestrator_core__lookup" }
        );
      }
      expect(last.additionalContext ?? "").not.toContain("Checkpoint hygiene");
      expect(last.additionalContext ?? "").not.toContain("checkpoint gap");
    });

    test("save_progress resets the cadence; subsequent turns go silent until work re-accumulates", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("RST");
      let fired: HookEventResponse = {};
      for (let i = 0; i < 13; i++) fired = workTurn(db, tracker, "RST");
      expect(fired.additionalContext).toContain("Checkpoint hygiene");
      // Agent checkpoints.
      handleHookEvent(
        { db, tracker },
        { event: "PostToolUse", session_id: "RST", tool_name: "mcp__plugin_orchestrator_core__save_progress" }
      );
      // Next turn: gap + activity reset -> silent.
      const after = handleHookEvent(
        { db, tracker },
        { event: "UserPromptSubmit", session_id: "RST", payload: { user_prompt: "w" } }
      );
      expect(after.additionalContext ?? "").not.toContain("Checkpoint hygiene");
      expect(after.additionalContext ?? "").not.toContain("checkpoint gap");
    });

    test("spaced (not every-turn) + escalates to URGENT over a long uncheckpointed run", () => {
      const { db, tracker } = freshSetup();
      tracker.registerSession("ESC");
      const nudges: string[] = [];
      for (let i = 0; i < 40; i++) {
        const r = handleHookEvent(
          { db, tracker },
          { event: "UserPromptSubmit", session_id: "ESC", payload: { user_prompt: "w" } }
        );
        const ac = r.additionalContext ?? "";
        if (/Checkpoint hygiene|Still uncheckpointed|URGENT checkpoint gap/.test(ac)) {
          nudges.push(ac);
        }
        handleHookEvent(
          { db, tracker },
          { event: "PostToolUse", session_id: "ESC", tool_name: "Edit", payload: { file_path: "f.ts" } }
        );
      }
      // Anti-noise invariant: a handful of nudges over 40 turns, NOT one per turn.
      expect(nudges.length).toBeGreaterThanOrEqual(2);
      expect(nudges.length).toBeLessThanOrEqual(8);
      // First is the gentle tier; escalates to URGENT later.
      expect(nudges[0]).toContain("Checkpoint hygiene");
      expect(nudges.some((n) => n.includes("URGENT"))).toBe(true);
    });
  });
});
