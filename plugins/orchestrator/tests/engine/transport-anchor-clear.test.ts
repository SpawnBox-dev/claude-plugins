import { describe, test, expect } from "bun:test";
import { deliveryObservedSince } from "../../mcp/engine/agent_channel";

// ===========================================================================
// 0.69.3 - THE IMMORTAL ANCHOR (cb376ece, root cause recorded on 99c00385).
//
// client_transport_suspect fired dozens of times on 2026-08-30/31 with zero
// confirmed true positives. The elapsed arithmetic was always CORRECT; what
// was wrong was the origin it measured from, which never advanced even while
// the subject demonstrably sent and received for hours.
//
// THE MECHANISM, read from source rather than inferred. At emit time the
// detector stores a size baseline:
//
//     selfSizeAtEmit = peerTranscriptSize(self)     // null if no file yet
//
// and cleared itself only when `selfSizeAtEmit !== null && size > baseline`.
// peerTranscriptSize returns NULL when the transcript file does not exist -
// which is exactly the state of a session at its FIRST emit, before the
// harness has created its .jsonl. So the clear condition was UNSATISFIABLE
// for any session whose first emit beat its own transcript into existence:
// pendingEmitAt could never be released, and the alert re-fired forever
// against an origin frozen at session start.
//
// THE PREDICTION THIS EXPLAINS, and it was observed before it was explained.
// If the anchor latches at a new session's first emit, the alert must fire
// CLIENT_STALE_MS (15 min) later, citing "a message sent at about your join
// time". On 2026-08-31 three freshly-joined sessions did exactly that:
//
//     CLAIMS     joined 20:05:55Z   alert cited ~20:05   (16 min later)
//     PLUGIN     joined 20:06:28Z   alert cited ~20:06   (15 min later)
//     DISCORD    joined 20:07:29Z   alert cited ~20:07   (16 min later)
//
// Three subjects, three matching offsets, one constant. The join-race shape
// was surfaced by SA-EYES from inbox observation; the source read here is
// what turns it from a suggestive pattern into a named cause.
//
// An absent transcript is ZERO BYTES, not "unknown" - that single distinction
// is the whole fix.
// ===========================================================================

describe("0.69.3: deliveryObservedSince - the clear condition that could not be met", () => {
  describe("THE REGRESSION: a null baseline must not be immortal", () => {
    test("absent-at-emit baseline clears as soon as anything is written", () => {
      // The exact join-race state. Under the old condition this returned
      // false FOREVER, no matter how much the session subsequently wrote.
      expect(deliveryObservedSince(4096, null)).toBe(true);
    });

    test("a large later transcript on a null baseline also clears", () => {
      expect(deliveryObservedSince(1_500_000, null)).toBe(true);
    });

    test("null baseline with nothing yet written stays unresolved", () => {
      // Zero bytes is not growth. The detector should still be waiting, not
      // clearing - otherwise it would stand down before it ever armed.
      expect(deliveryObservedSince(0, null)).toBe(false);
    });
  });

  describe("ordinary baselines behave exactly as before - no behaviour traded away", () => {
    test("growth past the baseline is observed delivery", () => {
      expect(deliveryObservedSince(150, 100)).toBe(true);
    });

    test("a byte-identical transcript is NOT delivery", () => {
      // PA's 11.37-hour freeze: the transcript was frozen, not growing. This
      // is the case the detector exists for and it must keep NOT clearing.
      expect(deliveryObservedSince(100, 100)).toBe(false);
    });

    test("a shrinking transcript is not delivery either", () => {
      expect(deliveryObservedSince(80, 100)).toBe(false);
    });
  });

  describe("UNKNOWN must never be reported as OBSERVED - the f7bc27b8 lesson", () => {
    // "I could not stat it" and "nothing was delivered" are different claims,
    // and so are "I could not stat it" and "delivery happened". A transient
    // read failure must leave the verdict untouched in BOTH directions.
    test("an unreadable transcript does not clear, even against a zero baseline", () => {
      expect(deliveryObservedSince(null, 0)).toBe(false);
    });

    test("an unreadable transcript does not clear against a null baseline", () => {
      expect(deliveryObservedSince(null, null)).toBe(false);
    });

    test("an unreadable transcript does not clear against a real baseline", () => {
      expect(deliveryObservedSince(null, 100)).toBe(false);
    });
  });
});
