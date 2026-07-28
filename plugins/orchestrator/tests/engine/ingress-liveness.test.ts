import { describe, test, expect } from "bun:test";
import {
  classifyIngress,
  isFleetDormant,
  FLEET_DORMANT_THRESHOLD_MS,
  ingressRefractoryElapsed,
  INGRESS_REFRACTORY_MS,
} from "../../mcp/engine/agent_channel";

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

// ===========================================================================
// 0.31.6: suppress the whole-fleet-dormant false-positive class.
//
// Firing #6 came at 13:09Z after the fleet had been idle overnight, and
// SA-b14fafa3 named the shape: "delivery unprocessed for >3min" is the
// EXPECTED state when nobody was awake. No triage step can resolve that as
// anything but a false alarm, which makes it noise BY CONSTRUCTION. With the
// detector 0-for-6, removing a systematic false class beats more wording.
//
// The discriminator is SELECTIVE quiet vs FLEET-WIDE quiet, measured from
// transcript mtime - the only signal that means "a turn ran". Heartbeat would
// be the wrong input: it stays fresh while idle, which is precisely the
// condition the alert already reports, so a heartbeat-keyed suppressor could
// never suppress. That warning came from PA and it is the trap this class of
// fix keeps falling into.
// ===========================================================================
describe("fleet-dormant suppression", () => {
  const T = FLEET_DORMANT_THRESHOLD_MS;

  test("SUPPRESSES when every peer has been silent past the threshold", () => {
    // Overnight: nobody has taken a turn in hours.
    expect(isFleetDormant([15 * 3600_000, 15 * 3600_000, 15 * 3600_000])).toBe(true);
  });

  test("FIRES when others are working and one is silent - the real signal", () => {
    // Five active peers; this is the case the detector exists for and it must
    // survive the suppressor untouched.
    expect(isFleetDormant([5_000, 12_000, 3_000, 30_000])).toBe(false);
  });

  test("a SINGLE active peer is enough to keep the detector armed", () => {
    // Selective quiet: one peer still working means the quiet is not fleet-wide.
    expect(isFleetDormant([15 * 3600_000, 15 * 3600_000, 1_000])).toBe(false);
  });

  test("a lone session does not suppress itself into permanent silence", () => {
    // No peers = no fleet to compare against. Behave exactly as before rather
    // than going quiet forever - a suppressor that can never stop suppressing
    // is the mirror of a detector that can never fire.
    expect(isFleetDormant([])).toBe(false);
  });

  test("boundary: exactly at the threshold counts as dormant", () => {
    expect(isFleetDormant([T, T])).toBe(true);
    expect(isFleetDormant([T, T - 1])).toBe(false);
  });

  test("the threshold is well above the 3-minute delivery window it guards", () => {
    // Otherwise a normal pause between turns would suppress a genuine park.
    expect(T).toBeGreaterThan(3 * 60_000);
  });
});

// ===========================================================================
// 0.31.7: refractory floor - the alert must remember it just asked.
//
// Firing #7 (0-for-7) refired on PA 22 minutes after PA had answered a direct
// address and closed #6. Measured AT THE MOMENT IT FIRED: PA's transcript was
// 2 seconds old and six of seven sessions had produced output within 20s. The
// subject was demonstrably alive and the fleet demonstrably awake - so this is
// a class the 0.31.6 dormant suppressor correctly does NOT catch.
//
// Cause: the episode dedup clears whenever a verdict goes healthy, so the
// alert re-arms and re-asks immediately, forever. SA-c5b207e0's framing: the
// subject's own recent output is far stronger proof of liveness than an
// unprocessed delivery is proof of the opposite - and their honest admission
// that they skipped the triage because they "judged it safe" is the alert
// training exactly the behaviour it must not train.
// ===========================================================================
describe("ingress refractory floor", () => {
  const R = INGRESS_REFRACTORY_MS;
  const now = 1_000_000_000_000;

  test("first ever firing is allowed", () => {
    expect(ingressRefractoryElapsed(undefined, now)).toBe(true);
  });

  test("SUPPRESSES a refire moments after the last one - the reported bug", () => {
    // 22 minutes, the exact gap between firings #6 and #7.
    expect(ingressRefractoryElapsed(now - 22 * 60_000, now)).toBe(false);
  });

  test("allows a genuinely new episode once the window elapses", () => {
    expect(ingressRefractoryElapsed(now - R, now)).toBe(true);
    expect(ingressRefractoryElapsed(now - R - 1, now)).toBe(true);
  });

  test("boundary is exact", () => {
    expect(ingressRefractoryElapsed(now - (R - 1), now)).toBe(false);
  });

  test("the window is longer than the delivery threshold it guards", () => {
    // Otherwise the alert could re-ask within a single ambiguous episode.
    expect(R).toBeGreaterThan(3 * 60_000);
  });

  test("is INDEPENDENT of fleet dormancy - they catch different classes", () => {
    // #7 fired with the fleet awake, so the dormant suppressor must not be
    // what stops it; and an overnight firing has no prior emit to refract
    // against. Each covers what the other cannot.
    expect(isFleetDormant([2_000, 5_000, 11_000])).toBe(false);
    expect(ingressRefractoryElapsed(now - 60_000, now)).toBe(false);
  });
});
