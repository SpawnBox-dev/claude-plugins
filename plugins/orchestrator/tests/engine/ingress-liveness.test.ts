import { describe, test, expect } from "bun:test";
import { classifyIngress } from "../../mcp/engine/agent_channel";

// ===========================================================================
// 0.30.77: guarding the REJECTED liveness mechanism, so it is not re-derived.
//
// The ingress_suspect detector went 0-for-3 on real parks (2026-07-27,
// PA-d4c8dda8; prior incidents in anti_patterns 4cbc023b / cce508ba /
// 13cc28bf). Three DIFFERENT causes produced one identical appearance from the
// channel: a long user-facing turn, a long build, and a PA that had
// DELIBERATELY CUT ITS OUTPUT because Jarid said the volume was burying the
// basics.
//
// That third case names the design error: measuring quiet builds a signal that
// PUNISHES COMPLIANCE WITH ANOTHER INSTRUCTION, and flags hardest exactly the
// agents who comply best. Output volume is not liveness.
//
// The tempting fix - "a transcript write IS liveness, so compare mtime against
// the enqueue" - is WRONG HERE, and the reason is invisible without reading the
// ingress path: THE ENQUEUE ITSELF IS WRITTEN INTO THE TARGET'S TRANSCRIPT.
// mtime >= enqueue therefore holds by construction for parked and healthy
// sessions alike, so gating on it disables the detector completely. A
// permanently-silent watchdog is worse than a noisy one: it reads as "no
// problems found".
//
// These tests pin that: passing a fresh mtime must NOT suppress a suspect
// verdict. If someone later wires mtime into the decision, these fail.
// ===========================================================================

const T = 180_000; // 3 min threshold
const now = 1_000_000_000_000;

function classify(over: Partial<Parameters<typeof classifyIngress>[0]> = {}) {
  return classifyIngress({
    heartbeatFresh: true,
    oldestOrphanEnqueueTs: now - T - 1,
    lastRealIsMidTurn: false,
    now,
    thresholdMs: T,
    ...over,
  });
}

describe("ingress_suspect: transcript mtime must NOT gate the verdict", () => {
  test("a fresh mtime does not suppress a genuine suspect verdict", () => {
    // The enqueue wrote the transcript, so mtime is always fresh. If this ever
    // returns "healthy", the detector has been silently disabled.
    expect(classify({ transcriptMtimeMs: now - 1 })).toBe("ingress_suspect");
  });

  test("verdict is identical whether mtime is fresh, stale, or absent", () => {
    const fresh = classify({ transcriptMtimeMs: now - 1 });
    const stale = classify({ transcriptMtimeMs: now - T - 60_000 });
    const absent = classify({ transcriptMtimeMs: null });
    const missing = classify({});
    expect(fresh).toBe("ingress_suspect");
    expect(stale).toBe(fresh);
    expect(absent).toBe(fresh);
    expect(missing).toBe(fresh);
  });

  test("the pre-existing guards still own the false-positive suppression", () => {
    // Absent peer -> egress territory, not ours.
    expect(classify({ heartbeatFresh: false })).toBe("healthy");
    // Mid-turn -> blocked-but-alive. This is the guard that SHOULD be catching
    // the long-turn and long-build false positives; the residual bug lives in
    // parseIngressTail deciding what counts as mid-turn, not here.
    expect(classify({ lastRealIsMidTurn: true })).toBe("healthy");
    // No orphan -> loop draining normally.
    expect(classify({ oldestOrphanEnqueueTs: null })).toBe("healthy");
    // Orphan too recent -> wait rather than alarm.
    expect(classify({ oldestOrphanEnqueueTs: now - 1000 })).toBe("pending");
  });
});
