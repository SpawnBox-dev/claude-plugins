import { describe, test, expect } from "bun:test";
import {
  shouldRenderRoster,
  rosterFingerprint,
  LOOP_CLOSE_REFRESH_TURNS,
} from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.30.89: loop-close nudges on STATE CHANGE, not on tick.
//
// PA reported ~30 identical firings across ~40 turns, naming one deliberately
// long-lived work item, and SA-4e3d2623 had the same experience for an entire
// session. PA's account is the damning part: "By turn ten I stopped reading
// it. If it had ever changed to name a DIFFERENT item, I'd probably have
// missed it."
//
// Same lesson as the roster fix (0.30.79) and the mirror of ea5bee61's
// concern: an advisory that fires constantly and IDENTICALLY trains its reader
// to filter it - and here it was filtered by the session most likely to have a
// real loop-close obligation.
//
// The fingerprint is over the in-flight SET plus each item's updated_at, so a
// new item, a closed item, or an EDITED item all re-render immediately.
// ===========================================================================

const A = "id-a:2026-07-27T10:00:00Z";
const A_EDITED = "id-a:2026-07-27T18:00:00Z";
const A_PLUS_B = "id-a:2026-07-27T10:00:00Z|id-b:2026-07-27T12:00:00Z";

function render(current: string, lastState: string | null, lastTurn: number | null, turn: number) {
  return shouldRenderRoster({
    current,
    lastFingerprint: lastState === null ? null : rosterFingerprint(lastState),
    lastTurn,
    turn,
    refreshTurns: LOOP_CLOSE_REFRESH_TURNS,
  });
}

describe("loop-close dedupe", () => {
  test("renders the first time", () => {
    expect(render(A, null, null, 1)).toBe(true);
  });

  test("suppresses the identical set on the next turn - the reported bug", () => {
    expect(render(A, A, 5, 6)).toBe(false);
  });

  test("re-renders immediately when a NEW item appears", () => {
    // The case PA feared missing: the set changed and it must not be filtered.
    expect(render(A_PLUS_B, A, 5, 6)).toBe(true);
  });

  test("re-renders immediately when an item is CLOSED (set shrinks)", () => {
    expect(render(A, A_PLUS_B, 5, 6)).toBe(true);
  });

  test("re-renders when an item is EDITED, even though the set is the same", () => {
    // updated_at is in the fingerprint precisely so an edit counts as a change.
    expect(render(A_EDITED, A, 5, 6)).toBe(true);
  });

  test("re-surfaces a static set after the floor, so it cannot vanish", () => {
    expect(render(A, A, 1, 1 + LOOP_CLOSE_REFRESH_TURNS)).toBe(true);
    expect(render(A, A, 1, LOOP_CLOSE_REFRESH_TURNS)).toBe(false);
  });

  test("floor is looser than the roster's - an unanswered question is not news", () => {
    expect(LOOP_CLOSE_REFRESH_TURNS).toBeGreaterThan(10);
  });
});
