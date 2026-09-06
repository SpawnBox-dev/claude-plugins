import { describe, expect, test } from "bun:test";
import {
  summarizeScanGaps,
  formatScanGapWarning,
  type EmitLogRecord,
} from "../../mcp/engine/agent_channel_emitlog";

// ===========================================================================
// SCAN-GAP SURFACING (WI 6cf7437a / 61da44fa).
//
// This exists because `post-reload-check.mjs` - correct, tested, and shipped
// the same day - is a thing a human must REMEMBER to run, which is the exact
// shape of the defect it detects. The precedent is not hypothetical:
// `install-mismatch` was right, fired five times, named the day's failure nine
// minutes ahead with the work-item id attached, and changed nothing, because
// it was written where nobody looks.
//
// The fixtures below are the REAL records from 2026-09-06 16:10-16:13Z, when a
// second watcher spawned under PA's window and raced it for the same bytes.
// Fabricated fixtures would have let the wording drift away from what the
// field data actually supports - and what it supports is the load-bearing
// distinction in this whole feature: A GAP IS A RACE ARTIFACT, NOT A LOSS.
// ===========================================================================

const gap = (
  ts: string,
  sender: string,
  from: number,
  to: number,
  receiver = "66e2a4f9",
): EmitLogRecord => ({
  ts,
  event: "scan_gap",
  receiver_id8: receiver,
  sender_id8: sender,
  scan_from: from,
  scan_to: to,
});

/** Verbatim from the emit log, the first four of the nineteen. */
const FIELD: EmitLogRecord[] = [
  gap("2026-09-06T16:10:50.806Z", "66e2a4f9", 105_000_000, 105_003_827),
  gap("2026-09-06T16:11:23.955Z", "28e29d5d", 16_400_000, 16_421_348),
  gap("2026-09-06T16:11:40.764Z", "66e2a4f9", 105_003_827, 105_069_057),
  gap("2026-09-06T16:11:41.967Z", "66e2a4f9", 105_069_057, 105_073_391),
];

describe("summarizeScanGaps", () => {
  test("THE FIELD CASE: counts, totals bytes, and names the affected senders", () => {
    const s = summarizeScanGaps(FIELD, "66e2a4f9", "2026-09-06T16:00:00.000Z");
    expect(s.count).toBe(4);
    expect(s.bytes).toBe(3_827 + 21_348 + 65_230 + 4_334);
    expect(s.senders).toEqual(["28e29d5d", "66e2a4f9"]);
    expect(s.firstTs).toBe("2026-09-06T16:10:50.806Z");
    expect(s.lastTs).toBe("2026-09-06T16:11:41.967Z");
  });

  test("CLEAN FLEET IS SILENT - the control that makes a hit mean something", () => {
    const s = summarizeScanGaps([], "66e2a4f9", "2026-09-06T16:00:00.000Z");
    expect(s.count).toBe(0);
    expect(formatScanGapWarning(s)).toBeNull();
  });

  test("gaps BEFORE this process started are excluded", () => {
    // The whole point of anchoring at process start: five gaps fired at 15:33
    // under a previous incarnation of this window. Counting them would make a
    // freshly-restarted window alarm about the state it was restarted to fix,
    // which is the fastest way to teach someone to ignore the banner.
    const s = summarizeScanGaps(FIELD, "66e2a4f9", "2026-09-06T16:11:30.000Z");
    expect(s.count).toBe(2);
  });

  test("ANOTHER SESSION'S GAPS ARE NOT MINE", () => {
    // A healthy window must never inherit a sick peer's alarm. The receiver
    // filter is what stops one duplicated session from lighting up the whole
    // fleet's briefings.
    const mixed = [...FIELD, gap("2026-09-06T16:12:00.000Z", "x", 0, 999_999, "745977db")];
    expect(summarizeScanGaps(mixed, "66e2a4f9", "2026-09-06T16:00:00.000Z").count).toBe(4);
    expect(summarizeScanGaps(mixed, "745977db", "2026-09-06T16:00:00.000Z").count).toBe(1);
  });

  test("non-gap records are ignored even from the same receiver", () => {
    const noise: EmitLogRecord[] = [
      { ts: "2026-09-06T16:11:00.000Z", event: "sent", receiver_id8: "66e2a4f9" },
      { ts: "2026-09-06T16:11:00.000Z", event: "received", receiver_id8: "66e2a4f9" },
    ];
    expect(summarizeScanGaps([...FIELD, ...noise], "66e2a4f9", "2026-09-06T16:00:00.000Z").count)
      .toBe(4);
  });

  test("a malformed range contributes a count but never negative bytes", () => {
    // Defensive: a record missing scan_to would otherwise subtract, and a
    // negative total would read as a smaller problem than the real one.
    const bad: EmitLogRecord[] = [
      { ts: "2026-09-06T16:11:00.000Z", event: "scan_gap", receiver_id8: "66e2a4f9" },
    ];
    const s = summarizeScanGaps(bad, "66e2a4f9", "2026-09-06T16:00:00.000Z");
    expect(s.count).toBe(1);
    expect(s.bytes).toBe(0);
  });
});

describe("formatScanGapWarning", () => {
  const s = summarizeScanGaps(FIELD, "66e2a4f9", "2026-09-06T16:00:00.000Z");

  test("REFUSES TO CLAIM LOSS - the line the wording must not cross", () => {
    // PA stated 157KB as if it were lost, then retracted it: the losing racer
    // logs the gap, the WINNING racer read those bytes and emitted them, and
    // the message arrives. It is loss only if the winner has no live client.
    // An alert that overstates its evidence gets discounted, and this one has
    // to survive being read during an incident.
    const w = formatScanGapWarning(s)!;
    expect(w).toContain("NOT PROOF OF LOSS");
    expect(w).toContain("non-deterministic");
  });

  test("states the remedy AND rules out the one that does not work", () => {
    const w = formatScanGapWarning(s)!;
    expect(w).toContain("RESTART THIS WINDOW");
    expect(w).toContain("respawns");
  });

  test("carries the numbers so a reader can verify rather than trust", () => {
    const w = formatScanGapWarning(s)!;
    expect(w).toContain("94,739");
    expect(w).toContain("4 times");
    expect(w).toContain("2026-09-06T16:10:50.806Z");
  });

  test("attributes the cause upstream so nobody re-hunts it in the plugin", () => {
    expect(formatScanGapWarning(s)!).toContain("claude-code#25976");
  });

  test("singular/plural does not read as a bug to whoever is already alarmed", () => {
    const one = summarizeScanGaps([FIELD[0]], "66e2a4f9", "2026-09-06T16:00:00.000Z");
    const w = formatScanGapWarning(one)!;
    expect(w).toContain("1 time while reading");
    expect(w).toContain("1 source transcript ");
    expect(w).not.toContain("1 times");
    expect(w).not.toContain("1 source transcripts");
  });

  test("NAMES THE SENDER IDS AS FILES, NEVER AS SESSIONS AT FAULT", () => {
    // `sender_id8` is derived from the FILENAME being scanned
    // (agent_channel.ts:2590), so it identifies the contested transcript, not
    // a party responsible. It is ALSO the only column here that visibly
    // varies - 195/74/14 across three ids on 2026-09-06 - which makes it look
    // like the discriminator for "who is doubled". It is not; that is
    // `receiver_id8`. TWO OF THOSE THREE IDS WERE SESSIONS PROVEN
    // SINGLE-WATCHERED BY PARENT CHAIN, so a reader taking this list as an
    // accusation would be wrong on 88 of 283 rows - a 31% false-positive rate
    // against a known-clean population. The wording has to close that door,
    // because the banner is read during an incident by someone deciding which
    // window to kill.
    const w = formatScanGapWarning(s)!;
    expect(w).toContain("NOT sessions at fault");
    expect(w).toContain("FILES contended for");
    expect(w).not.toContain("senders");
  });
});
