import { describe, test, expect } from "bun:test";
import {
  formatClientTransportAlert,
  formatUnroutedTranscriptAlert,
} from "../../mcp/engine/agent_channel";

// ===========================================================================
// client_transport_suspect wording, pinned.
//
// 0.69.3 (f7bc27b8) hoisted the text out of the tick loop so it could be
// asserted, and pinned an ORDER: two "free checks" before the /mcp remedy,
// plus an inline base rate. 2026-09-28 (WI cb376ece, Jarid ruling KB
// 27f1613d) REVERSES that design, and these tests pin the reversal.
//
// WHY. On 2026-09-27 two lanes ran /clear. Messages TO them kept arriving;
// their POSTS went to a transcript no row owned and were dropped for ~23
// hours. This alert fired about them all night and was TRUE. PA and three
// lanes dismissed it about nine times using check 1 ("from_task reacts to
// newer content, so the lane RECEIVED, refuted at zero cost") - which proves
// inbound delivery only. The text handed readers the dismissal. The ruling: a
// broken signal reaches the USER, and no agent reasons it away.
//
// So the load-bearing assertions are now NEGATIVE: the refutation wording and
// the base rate must never return, and the text must say in words that
// from_task cannot refute it.
// ===========================================================================

const SPECIMEN = {
  name: "SA-VIDEO-WORKFLOW-2026-09-23",
  id8: "efd22df3",
  anchor: "2026-09-27T02:02:20.000Z",
  waitMin: 1411,
  transcriptId: "efd22df3-626e-4256-a001-72e097885ea8",
  transcriptMtime: "2026-09-27T01:52:23.000Z",
  transcriptSize: 212396585,
  heartbeatAgeSec: 12,
  now: "2026-09-28T01:33:00.000Z",
};

const text = () => formatClientTransportAlert(SPECIMEN);

describe("client_transport_suspect: a user escalation, not advice", () => {
  test("opens as a USER ESCALATION addressed to PA", () => {
    const t = text();
    expect(t.startsWith("[client_transport_suspect] USER ESCALATION")).toBe(true);
    expect(t).toContain("PA: relay this to Jarid in this turn");
    expect(t).toContain("Do not rule it false yourself");
  });

  test("the zero-cost refutation and the base rate are GONE", () => {
    const t = text();
    expect(t).not.toContain("refuted");
    expect(t).not.toContain("at zero cost");
    expect(t).not.toContain("BASE RATE");
    expect(t).not.toContain("TWO FREE CHECKS");
    expect(t).not.toContain("ONLY IF BOTH ARE INCONCLUSIVE");
    expect(t).not.toContain("far more often than right");
  });

  test("says outright that from_task and quoted rulings prove only INBOUND", () => {
    const t = text();
    expect(t).toContain("DO NOT RULE THIS FALSE FROM from_task");
    expect(t).toContain("INBOUND");
    expect(t).toContain("OUTBOUND");
  });

  test("still never reasserts the pre-0.69.3 fact-about-the-subject sentence", () => {
    expect(text()).not.toContain("its transcript has not been written to since");
  });
});

describe("the alert carries its own evidence", () => {
  test("names the routed transcript file", () => {
    expect(text()).toContain(`${SPECIMEN.transcriptId}.jsonl`);
  });

  test("prints the transcript's last write next to the anchor", () => {
    const t = text();
    expect(t).toContain(SPECIMEN.transcriptMtime);
    expect(t).toContain(SPECIMEN.anchor);
    expect(t).toContain(String(SPECIMEN.waitMin));
  });

  test("a last write at or before the anchor is called out as a stopped transcript", () => {
    expect(text()).toContain("AT OR BEFORE the anchor");
  });

  test("a last write AFTER the anchor is not called stopped", () => {
    const t = formatClientTransportAlert({
      ...SPECIMEN,
      transcriptMtime: "2026-09-28T01:30:00.000Z",
    });
    expect(t).not.toContain("AT OR BEFORE the anchor");
    expect(t).toContain("after the anchor");
  });

  test("an unreadable transcript says so instead of guessing", () => {
    const t = formatClientTransportAlert({ ...SPECIMEN, transcriptMtime: null });
    expect(t).toContain("COULD NOT BE READ");
  });

  test("the heartbeat age is shown, since a fresh heartbeat is half the evidence", () => {
    expect(text()).toContain("last heartbeat 12s ago");
  });
});

describe("the one deciding check and the remedy", () => {
  test("names the transcript listing as the deciding check", () => {
    expect(text()).toContain("THE DECIDING CHECK: ls -lt");
  });

  test("the remedy is a user action, with proof of routing afterwards", () => {
    const t = text();
    expect(t).toContain("REMEDY (Jarid's action): /mcp");
    expect(t).toContain("unique token");
  });

  test("names the subject and says it cannot see the message", () => {
    const t = text();
    expect(t).toContain(SPECIMEN.name);
    expect(t).toContain(SPECIMEN.id8);
    expect(t).toContain("cannot see this message");
  });
});

describe("unrouted_transcript wording", () => {
  const u = () =>
    formatUnroutedTranscriptAlert({
      laneName: "SA-155-FRONTEND-2026-09-25",
      laneId8: "ed13ca91",
      laneTranscriptId: "ed13ca91-7629-4c72-a8ed-fda99d4a9887",
      unroutedTranscriptId: "89c514ba-0a89-47bb-839b-9da54181e2f4",
      unroutedMtime: "2026-09-28T01:30:00.000Z",
      laneTranscriptMtime: "2026-09-27T01:46:24.000Z",
      droppedLines: 412,
      firstDroppedAt: "2026-09-27T01:48:13.000Z",
    });

  test("is a user escalation naming the lane and both files", () => {
    const t = u();
    expect(t).toContain("USER ESCALATION");
    expect(t).toContain("SA-155-FRONTEND-2026-09-25 (ed13ca91)");
    expect(t).toContain("89c514ba-0a89-47bb-839b-9da54181e2f4.jsonl");
    expect(t).toContain("ed13ca91-7629-4c72-a8ed-fda99d4a9887.jsonl");
    expect(t).toContain("412 routable line(s) dropped");
  });

  test("pre-empts the dismissal that happened on 2026-09-27", () => {
    expect(u()).toContain("They prove nothing about its posts");
  });
});
