import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { SessionTracker } from "../../mcp/engine/session_tracker";
import { handleHookEvent } from "../../mcp/tools/hook_event";

// WI 7844a909 - THE INTEGRATION TEST, and it exists because the unit test was
// not enough.
//
// The first version of this nudge was placed INSIDE the Stop housekeeping
// block. That block is gated by `stop_<sid>` and fires exactly ONCE per session
// ("Block once per session id, then pass through"), so the nudge could only
// ever be evaluated at the first hand-back - when a declaration is newest - and
// would never have fired in practice. It was committed, and its unit test
// PASSED, because the unit test called the function directly and never went
// through the real invocation path.
//
// PA's gate pass rode that same unit test and missed it too. So: this file
// drives the REAL dispatcher, handleHookEvent({event:"Stop"}), the way Claude
// Code does. If the nudge is ever moved back behind a once-per-session gate,
// these fail.
//
// This is the same lesson as the guards this codebase keeps finding: a function
// that is correct in isolation and never invoked is indistinguishable, in test
// output, from one that works.

const SID = "integration-stale-session";
const TURNS = 30; // must track STALE_TASK_TURNS

function setup() {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  const tracker = new SessionTracker(db);
  tracker.registerSession(SID);
  return { db, tracker, ctx: { db, tracker } };
}

/** Drive N real Stop events; return the CONCATENATED text of all of them.
 *  Accumulating matters: the nudge fires on one specific turn and then resets,
 *  so inspecting only the last response would miss it - which is exactly the
 *  off-by-one that made the first draft of this test fail against working
 *  code. */
function stops(ctx: any, n: number): string {
  let acc = "";
  for (let i = 0; i < n; i++) {
    const r: any = handleHookEvent(ctx, { event: "Stop", session_id: SID } as any);
    acc += `${r?.reason ?? ""}${r?.systemMessage ?? ""}${r?.additionalContext ?? ""}`;
  }
  return acc;
}

describe("stale-task nudge THROUGH the real Stop path", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  test("FIRES on the Nth stale turn via handleHookEvent", () => {
    // The assertion the previous design could never have satisfied: the
    // housekeeping block it lived in had already fired and returned {} by turn
    // 2, so turns 2..30 produced nothing at all.
    env.tracker.updateCurrentTask(SID, "ORCH-IMP: shipped 0.44.0 + 0.44.1");
    const out = stops(env.ctx, TURNS + 1); // +1: turn 1 is the housekeeping turn
    expect(out).toContain("update_session_task");
    expect(out).toContain("0.44.0");
  });

  test("stays SILENT on a fresh declaration", () => {
    env.tracker.updateCurrentTask(SID, "ORCH-IMP: currently fixing the roster");
    const out = stops(env.ctx, 5);
    expect(out).not.toContain("update_session_task");
  });

  test("stays SILENT for a PARKED session that never declared", () => {
    // No declaration -> nothing to be stale about, however many turns pass.
    const out = stops(env.ctx, TURNS + 5);
    expect(out).not.toContain("update_session_task");
  });

  test("re-declaring mid-run resets it - the escape hatch the text promises", () => {
    env.tracker.updateCurrentTask(SID, "task A");
    stops(env.ctx, TURNS - 2);
    env.tracker.updateCurrentTask(SID, "task B - re-declared");
    const out = stops(env.ctx, 5);
    expect(out).not.toContain("update_session_task");
  });

  test("survives the once-per-session housekeeping gate", () => {
    // Directly pins the bug: the FIRST Stop delivers housekeeping and sets
    // stop_<sid>; every later Stop hits `if (exists)`. The nudge must still be
    // reachable on those later turns, which is only true because it is
    // evaluated BEFORE that gate.
    env.tracker.updateCurrentTask(SID, "a declaration that will go stale");
    const first = stops(env.ctx, 1);
    expect(first.length).toBeGreaterThan(0); // housekeeping delivered
    const later = stops(env.ctx, TURNS);
    expect(later).toContain("update_session_task"); // still reachable past the gate
  });
});
