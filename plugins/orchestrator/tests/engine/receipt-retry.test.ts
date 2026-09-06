import { describe, test, expect } from "bun:test";
import { pendingRetries, type EmitLogRecord } from "../../mcp/engine/agent_channel_emitlog";

// ===========================================================================
// WI 6cf7437a - RECEIPTS AND RETRY.
//
// WHY THIS SHAPE. Loss was measured to be UNCORRELATED with message size,
// class and character content: delivered vs lost length distributions are
// p25/med/p75 = 98/115/183 against 98/115/182, no character class separates
// them, and directed vs ambient loss came out 20% vs 28% on n=10/208. Uniform
// loss independent of payload is a lossy TRANSPORT, and the remedy for a lossy
// transport is detect-and-resend, not better classification.
//
// THE RISK THIS FILE EXISTS TO CONTAIN: a retry loop that misjudges
// "unacknowledged" duplicates traffic on a transport that is already dropping
// under load - turning a diagnosis into an outage. Every arm below is about
// NOT retrying when we should not.
// ===========================================================================

const SELF = "aaaaaaaa";
const T0 = new Date("2026-09-06T12:00:00.000Z").getTime();
const at = (msAfter: number) => new Date(T0 + msAfter).toISOString();
const rec = (o: Partial<EmitLogRecord>): EmitLogRecord =>
  ({ ts: at(0), event: "sent", receiver_id8: SELF, ...o }) as EmitLogRecord;

describe("pendingRetries - when NOT to retry", () => {
  test("a message with a receipt is never retried", () => {
    const rows = [
      rec({ event: "sent", emit_id: "a", ts: at(0) }),
      rec({ event: "received", emit_id: "a", ts: at(500) }),
    ];
    expect(pendingRetries(rows, SELF, T0 + 600_000)).toEqual([]);
  });

  test("a receipt recorded by ANOTHER session still counts", () => {
    // The receiver asserts delivery, not us. Filtering receipts by our own id
    // would discard exactly the evidence we are looking for - and would make
    // every delivered message look unacknowledged, i.e. retry everything.
    const rows = [
      rec({ event: "sent", emit_id: "a", ts: at(0) }),
      rec({ event: "received", emit_id: "a", receiver_id8: "bbbbbbbb", ts: at(500) }),
    ];
    expect(pendingRetries(rows, SELF, T0 + 600_000)).toEqual([]);
  });

  test("a message younger than the grace window is NOT retried", () => {
    // The load-bearing arm against self-inflicted flooding. Measured delivery
    // latency was median 0.7s but p90 13s and max 42s, so a short grace would
    // re-send healthy traffic and multiply load precisely when the transport
    // is already struggling.
    const rows = [rec({ event: "sent", emit_id: "a", ts: at(0) })];
    expect(pendingRetries(rows, SELF, T0 + 30_000, 60_000)).toEqual([]);
    expect(pendingRetries(rows, SELF, T0 + 61_000, 60_000)).toHaveLength(1);
  });

  test("retries STOP at the attempt ceiling", () => {
    // An undeliverable message must eventually stop. Infinite retry against a
    // persistently broken receiver is a flood, and it would grow the emit log
    // without bound.
    const rows = [
      rec({ event: "sent", emit_id: "a", ts: at(0) }),
      rec({ event: "retry", emit_id: "a", ts: at(60_000) }),
      rec({ event: "retry", emit_id: "a", ts: at(120_000) }),
      rec({ event: "retry", emit_id: "a", ts: at(180_000) }),
    ];
    expect(pendingRetries(rows, SELF, T0 + 600_000, 60_000, 3)).toEqual([]);
  });

  test("someone else's sends are not our job to retry", () => {
    const rows = [rec({ event: "sent", emit_id: "a", receiver_id8: "bbbbbbbb", ts: at(0) })];
    expect(pendingRetries(rows, SELF, T0 + 600_000)).toEqual([]);
  });

  test("records without an emit_id are ignored, not crashed on", () => {
    const rows = [
      rec({ event: "sent", ts: at(0) }),
      rec({ event: "unknown_sender", ts: at(0) }),
      rec({ event: "sent", emit_id: "a", ts: at(0) }),
    ];
    expect(pendingRetries(rows, SELF, T0 + 600_000).map((r) => r.emit_id)).toEqual(["a"]);
  });

  test("a malformed timestamp is skipped rather than treated as infinitely old", () => {
    // Otherwise one corrupt line retries forever on every pass.
    const rows = [rec({ event: "sent", emit_id: "a", ts: "not-a-date" })];
    expect(pendingRetries(rows, SELF, T0 + 600_000)).toEqual([]);
  });
});

describe("pendingRetries - when it SHOULD retry", () => {
  test("sent, past grace, no receipt -> retry, carrying the attempt count", () => {
    const rows = [
      rec({ event: "sent", emit_id: "a", ts: at(0) }),
      rec({ event: "retry", emit_id: "a", ts: at(60_000) }),
    ];
    const out = pendingRetries(rows, SELF, T0 + 600_000, 60_000, 3);
    expect(out).toHaveLength(1);
    expect(out[0].emit_id).toBe("a");
    expect(out[0].attempts).toBe(1);
    expect(out[0].sentAt).toBe(at(0));
  });

  test("uses the FIRST send as the age anchor, not the latest retry", () => {
    // Anchoring on the newest event would keep pushing the deadline forward and
    // a message could sit unacknowledged indefinitely while always looking fresh.
    const rows = [
      rec({ event: "sent", emit_id: "a", ts: at(0) }),
      rec({ event: "sent", emit_id: "a", ts: at(500_000) }),
    ];
    expect(pendingRetries(rows, SELF, T0 + 600_000, 60_000)[0].sentAt).toBe(at(0));
  });

  test("several unacknowledged messages all come back", () => {
    const rows = [
      rec({ event: "sent", emit_id: "a", ts: at(0) }),
      rec({ event: "sent", emit_id: "b", ts: at(0) }),
      rec({ event: "sent", emit_id: "c", ts: at(0) }),
      rec({ event: "received", emit_id: "b", ts: at(100) }),
    ];
    expect(pendingRetries(rows, SELF, T0 + 600_000).map((r) => r.emit_id).sort()).toEqual(["a", "c"]);
  });

  test("an empty log produces no retries", () => {
    expect(pendingRetries([], SELF, T0)).toEqual([]);
  });
});
