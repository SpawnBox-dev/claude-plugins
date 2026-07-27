import { describe, test, expect } from "bun:test";
import {
  shouldRenderRoster,
  rosterFingerprint,
  ROSTER_REFRESH_TURNS,
} from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.30.79: sibling-roster dedupe.
//
// PA reported the roster arriving 5-15 times per turn. There is only one call
// site, so the multiplier is not duplicated composition - UserPromptSubmit
// fires for EVERY INBOUND CHANNEL DELIVERY, and PA (as prime) receives an
// event for everything anyone else says. So the tax scales with inbound volume
// and lands entirely on the ONE session with high volume by construction: the
// one with the largest context and the most compactions.
//
// Content-keyed, not turn-keyed, deliberately: the roster's value is telling
// you when the fleet CHANGED, so suppressing an identical block is free while
// suppressing a changed one would break the feature.
// ===========================================================================

const ROSTER_A = "[orch] 5 sibling sessions active:\n  - aaa (prime): thing";
const ROSTER_B = "[orch] 5 sibling sessions active:\n  - aaa (prime): DIFFERENT";

describe("sibling roster dedupe", () => {
  test("renders the first time it is ever seen", () => {
    expect(
      shouldRenderRoster({ current: ROSTER_A, lastFingerprint: null, lastTurn: null, turn: 1 })
    ).toBe(true);
  });

  test("suppresses an IDENTICAL roster on the next delivery", () => {
    // This is the PA case: many deliveries inside one turn, same block each time.
    expect(
      shouldRenderRoster({
        current: ROSTER_A,
        lastFingerprint: rosterFingerprint(ROSTER_A),
        lastTurn: 5,
        turn: 6,
      })
    ).toBe(false);
  });

  test("ALWAYS renders when the roster CHANGES, even one delivery later", () => {
    // A session joining, departing, or updating its task is exactly what the
    // roster exists to tell you. Suppressing this would break the feature.
    expect(
      shouldRenderRoster({
        current: ROSTER_B,
        lastFingerprint: rosterFingerprint(ROSTER_A),
        lastTurn: 5,
        turn: 6,
      })
    ).toBe(true);
  });

  test("re-renders an unchanged roster once the turn floor elapses", () => {
    // Safety net so a session that compacts during a static period gets the
    // roster back within a bounded window.
    const fp = rosterFingerprint(ROSTER_A);
    // elapsed = turn - lastTurn, so the floor is reached at lastTurn + N.
    expect(
      shouldRenderRoster({
        current: ROSTER_A,
        lastFingerprint: fp,
        lastTurn: 1,
        turn: 1 + ROSTER_REFRESH_TURNS,
      })
    ).toBe(true);
    expect(
      shouldRenderRoster({
        current: ROSTER_A,
        lastFingerprint: fp,
        lastTurn: 1,
        turn: ROSTER_REFRESH_TURNS,
      })
    ).toBe(false);
  });

  test("renders on a counter reset rather than going silent", () => {
    // Negative gap = the in-memory turn counter reset below the persisted one
    // (MCP restart). Same convention as the warden-nudge gap guard: never let a
    // restart silence a signal.
    expect(
      shouldRenderRoster({
        current: ROSTER_A,
        lastFingerprint: rosterFingerprint(ROSTER_A),
        lastTurn: 50,
        turn: 2,
      })
    ).toBe(true);
  });

  test("never renders an empty roster", () => {
    expect(
      shouldRenderRoster({ current: "", lastFingerprint: null, lastTurn: null, turn: 1 })
    ).toBe(false);
  });

  test("fingerprint is stable and discriminating", () => {
    expect(rosterFingerprint(ROSTER_A)).toBe(rosterFingerprint(ROSTER_A));
    expect(rosterFingerprint(ROSTER_A)).not.toBe(rosterFingerprint(ROSTER_B));
  });
});
