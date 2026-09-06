import { describe, test, expect } from "bun:test";
import {
  parseEmitId,
  findCounterGaps,
  formatLossReport,
  summarizeLoss,
  extractSeenEmitIds,
  newEmitId,
  type EmitLogRecord,
} from "../../mcp/engine/agent_channel_emitlog";

// ===========================================================================
// WI 6cf7437a (c) - TWO DETECTORS, DISJOINT COVERAGE.
//
// PA's constraint, and the reason this file exists: unknown_sender and
// emit_id counter gaps CANNOT see each other's failures. A roster/identity
// miss never reaches newEmitId, so no id is minted and no gap can appear
// anywhere; a counter gap means an id WAS minted and the send completed, so
// nothing was discarded. A report built on either alone is a subset that
// reads as full coverage - which is worse than no report, because it looks
// like an all-clear.
//
// The load-bearing tests here are therefore not "does it count" but:
//   - a restart must not manufacture losses (the epoch trap)
//   - the edges of a window must not manufacture losses
//   - a clean window must produce NO output, so the report keeps meaning
// ===========================================================================

/** A successfully-read seen-window covering everything. The `measured` flag is
 *  the point: an unreadable transcript is a THIRD state, neither clean nor
 *  lossy, and tests that could not express it are how the blocker got in. */
const win = (ids: string[], since: string | null = null) => ({ ids, since, measured: true });
/** The failure case: the transcript could not be read at all. */
const unread = { ids: [] as string[], since: null, measured: false };

describe("parseEmitId", () => {
  test("splits a real generated id into epoch and sequence", () => {
    const id = newEmitId();
    const p = parseEmitId(id);
    expect(p).not.toBeNull();
    expect(typeof p!.epoch).toBe("string");
    expect(Number.isFinite(p!.seq)).toBe(true);
  });

  test("sequence is monotonic within one process", () => {
    const a = parseEmitId(newEmitId())!;
    const b = parseEmitId(newEmitId())!;
    expect(b.epoch).toBe(a.epoch === b.epoch ? a.epoch : b.epoch);
    if (a.epoch === b.epoch) expect(b.seq).toBe(a.seq + 1);
  });

  test("returns null on junk rather than throwing", () => {
    expect(parseEmitId("")).toBeNull();
    expect(parseEmitId("nodashes")).toBeNull();
  });
});

describe("findCounterGaps", () => {
  test("finds an interior gap - the actual detection", () => {
    const r = findCounterGaps(["ep-1-a", "ep-2-b", "ep-4-c"]);
    expect(r.missing).toBe(1);
    expect(r.gaps).toEqual([{ epoch: "ep", seq: 3 }]);
    expect(r.observed).toBe(3);
  });

  test("finds several gaps", () => {
    const r = findCounterGaps(["ep-1-a", "ep-5-b"]);
    expect(r.missing).toBe(3);
    expect(r.gaps.map((g) => g.seq)).toEqual([2, 3, 4]);
  });

  test("a consecutive run reports nothing", () => {
    // PA's own live reading was 18 emits, 18 sents, 1..18 consecutive. That
    // has to come back clean or the detector cries wolf on a healthy fleet.
    const ids = [];
    for (let s = 1; s <= 18; s++) ids.push(`ep-${s.toString(36)}-x`);
    const r = findCounterGaps(ids);
    expect(r.missing).toBe(0);
    expect(r.observed).toBe(18);
  });

  test("AN MCP RESTART MUST NOT MANUFACTURE LOSSES", () => {
    // The trap this detector exists to avoid. The counter resets to 0 on
    // restart while the epoch prefix changes. Compared as raw counters,
    // 1,2,3 then 1,2,3 looks like a clean run, and 40,41 then 1,2 looks like
    // a 38-message catastrophe. Grouping by epoch is what makes the figure
    // mean anything.
    const r = findCounterGaps(["old-1-a", "old-2-b", "new-1-c", "new-2-d"]);
    expect(r.missing).toBe(0);
    expect(r.observed).toBe(4);
  });

  test("a restart with a HIGH prior counter still reports nothing", () => {
    const r = findCounterGaps(["old-14-a", "old-15-b", "new-1-c"]);
    expect(r.missing).toBe(0);
  });

  test("window edges are not evidence", () => {
    // A missing id below the lowest seen only means we started watching
    // mid-stream; above the highest, it has not been emitted yet. Counting
    // either would fabricate losses out of where we happened to start.
    const r = findCounterGaps(["ep-5-a", "ep-6-b", "ep-7-c"]);
    expect(r.missing).toBe(0);
  });

  test("an empty window is clean, not a total loss", () => {
    expect(findCounterGaps([]).missing).toBe(0);
    expect(findCounterGaps([]).observed).toBe(0);
  });

  test("duplicate deliveries do not hide a gap", () => {
    // Duplicate delivery is a real observed behaviour (open_thread 60c0ada6),
    // so the detector must dedupe by sequence rather than count occurrences.
    const r = findCounterGaps(["ep-1-a", "ep-1-a", "ep-3-b"]);
    expect(r.missing).toBe(1);
    expect(r.observed).toBe(2);
  });
});

describe("formatLossReport", () => {
  test("SILENT when both detectors are clean", () => {
    // A report that prints a reassuring zero every time stops being read, and
    // then the one that matters is skimmed too.
    expect(
      formatLossReport({
        discarded: {},
        discardedTotal: 0,
        counterGaps: 0,
        observedEmits: 40,
        measured: true,
      }),
    ).toBeNull();
  });

  describe("UNMEASURED is a third state - neither clean nor lossy", () => {
    // THE BLOCKER PA CAUGHT. If the transcript read fails, the seen-set is
    // empty, so every sent id looks missing and the report announced that
    // EVERY message was lost - a maximal false alarm. Worse than a crash,
    // because the block still produced output, so a broken instrument
    // impersonated a finding.
    test("never reports a number when the transcript could not be read", () => {
      const out = formatLossReport({
        discarded: {},
        discardedTotal: 0,
        counterGaps: 40, // what the old code would have computed
        observedEmits: 40,
        measured: false,
      })!;
      expect(out).toContain("COULD NOT BE MEASURED");
      expect(out).toContain("NOT a finding of loss");
      expect(out).toContain("NOT an all-clear");
      // The fabricated total must not appear as a loss count.
      expect(out).not.toContain("40 notification(s) were emitted and sent but never");
    });

    test("is never SILENT either - silence would claim a healthy check ran", () => {
      expect(
        formatLossReport({
          discarded: {},
          discardedTotal: 0,
          counterGaps: 0,
          observedEmits: 0,
          measured: false,
        }),
      ).not.toBeNull();
    });

    test("still reports the discard half, which is measured independently", () => {
      const out = formatLossReport({
        discarded: { bbbbbbbb: 3 },
        discardedTotal: 3,
        counterGaps: 0,
        observedEmits: 12,
        measured: false,
      })!;
      expect(out).toContain("COULD NOT BE MEASURED");
      expect(out).toContain("bbbbbbbb:3");
      expect(out).toContain("that half is measured and is real");
    });
  });

  test("reports discards even when the counter is clean", () => {
    // The disjointness, asserted. A discard leaves NO counter gap, so if the
    // report keyed on gaps this case would be silent - which is precisely the
    // subset-that-reads-as-coverage failure.
    const out = formatLossReport({
      discarded: { "3f2eac48-1df2-46f6-8db6-670efcb066a6": 2 },
      discardedTotal: 2,
      counterGaps: 0,
      observedEmits: 40, measured: true,
    });
    expect(out).not.toBeNull();
    expect(out).toContain("READ AND DISCARDED");
    expect(out).toContain("3f2eac48");
    expect(out).toContain("NO gap at any receiver");
  });

  test("reports counter gaps even when nothing was discarded", () => {
    const out = formatLossReport({
      discarded: {},
      discardedTotal: 0,
      counterGaps: 3,
      observedEmits: 40, measured: true,
    });
    expect(out).not.toBeNull();
    expect(out).toContain("never");
    expect(out).toContain("past this plugin's boundary");
    // The denominator travels with the figure - 3 of 40 and 3 of 4 are very
    // different claims.
    expect(out).toContain("40");
  });

  test("reports BOTH when both fire, in one line", () => {
    const out = formatLossReport({
      discarded: { aaaaaaaa: 1, bbbbbbbb: 4 },
      discardedTotal: 5,
      counterGaps: 2,
      observedEmits: 100, measured: true,
    })!;
    expect(out).toContain("READ AND DISCARDED");
    expect(out).toContain("past this plugin's boundary");
    // Highest-count sender first, so the worst-affected peer is not buried.
    expect(out.indexOf("bbbbbbbb")).toBeLessThan(out.indexOf("aaaaaaaa"));
  });

  test("tells the reader what to DO, not just that a number moved", () => {
    const out = formatLossReport({
      discarded: { aaaaaaaa: 1 },
      discardedTotal: 1,
      counterGaps: 0,
      observedEmits: 10, measured: true,
    })!;
    expect(out).toContain("re-ask");
    expect(out).toContain("emit_id");
  });
});

describe("extractSeenEmitIds", () => {
  test("matches the ATTRIBUTE form, not prose about emit_id", () => {
    // Measured trap: my own first count of 4 'emit_id' hits in a transcript
    // was entirely my own writing ABOUT emit_id, and reading it as coverage
    // would have said the harness kept the key when nothing had tested it.
    const transcript =
      `{"text":"I added an emit_id to the meta and emit_id should survive"}\n` +
      `{"text":"<channel source='x' emit_id=\"abc-1-z\" ts='...'>hi</channel>"}\n`;
    expect(extractSeenEmitIds(transcript)).toEqual(["abc-1-z"]);
  });

  test("returns every occurrence, in order", () => {
    expect(extractSeenEmitIds(`emit_id="a-1-x" ... emit_id="a-2-y"`)).toEqual(["a-1-x", "a-2-y"]);
  });

  test("matches the ESCAPED form as it actually appears on disk", () => {
    // The load-bearing arm. The tag sits inside a JSON string in the JSONL, so
    // the real bytes are emit_id=\"...\". A matcher anchored on the unescaped
    // form returns [] and reads as "the harness dropped the key" - a broken
    // instrument impersonating a finding. PA hit exactly this from the other
    // side: its unescaped grep over JSONL returned zero.
    const onDisk = String.raw`{"content":"<channel source=\"x\" emit_id=\"abc-1-z\">hi</channel>"}`;
    expect(extractSeenEmitIds(onDisk)).toEqual(["abc-1-z"]);
  });

  test("handles both forms in one input", () => {
    const mixed = `emit_id="plain-1-a"` + String.raw` and emit_id=\"esc-2-b\"`;
    expect(extractSeenEmitIds(mixed)).toEqual(["plain-1-a", "esc-2-b"]);
  });

  test("empty transcript yields nothing rather than throwing", () => {
    expect(extractSeenEmitIds("")).toEqual([]);
  });
});

describe("summarizeLoss - both detectors against one receiver", () => {
  const rec = (o: Partial<EmitLogRecord>): EmitLogRecord =>
    ({ ts: "t", event: "emit", receiver_id8: "aaaaaaaa", ...o }) as EmitLogRecord;

  test("counts discards for THIS receiver only", () => {
    // The log is shared by every session in the project, so a summary that
    // forgot to filter would report a peer's losses as this session's.
    const r = summarizeLoss([
        rec({ event: "unknown_sender", receiver_id8: "aaaaaaaa", sender_id8: "bbbbbbbb" }),
        rec({ event: "unknown_sender", receiver_id8: "cccccccc", sender_id8: "bbbbbbbb" }),
      ], "aaaaaaaa", win([]),
    );
    expect(r.discardedTotal).toBe(1);
    expect(r.discarded).toEqual({ bbbbbbbb: 1 });
  });

  test("a gap needs the id to have been SENT, not merely emitted", () => {
    // An emit that never got sent is a different, separately-logged failure.
    // Counting it as a harness drop would double-report one loss as two.
    const records = [
      rec({ event: "emit", emit_id: "ep-1-a" }),
      rec({ event: "sent", emit_id: "ep-1-a" }),
      rec({ event: "emit", emit_id: "ep-2-b" }), // emitted, never sent
      rec({ event: "emit", emit_id: "ep-3-c" }),
      rec({ event: "sent", emit_id: "ep-3-c" }),
    ];
    // Receiver saw 1 and 3. Id 2 was never sent, so the observed sequence is
    // 1,3 with no interior gap - not a loss.
    const r = summarizeLoss(records, "aaaaaaaa", win(["ep-1-a", "ep-3-c"]));
    expect(r.counterGaps).toBe(0);
  });

  test("detects a genuine harness drop: sent but never seen", () => {
    const records = [
      rec({ event: "sent", emit_id: "ep-1-a" }),
      rec({ event: "sent", emit_id: "ep-2-b" }),
      rec({ event: "sent", emit_id: "ep-3-c" }),
    ];
    const r = summarizeLoss(records, "aaaaaaaa", win(["ep-1-a", "ep-3-c"]));
    expect(r.counterGaps).toBe(1);
    // Denominator is what we SENT (3), not what arrived (2) - "1 of 3 sent"
    // is the honest ratio; "1 of 2 observed" would understate the sample.
    expect(r.observedEmits).toBe(3);
  });

  test("seen ids that were never sent by us are ignored, not counted as coverage", () => {
    // Guards the tautology: `seen` comes from the transcript and may contain
    // ids minted by some other process. Only ids WE sent can be expected.
    const r = summarizeLoss([rec({ event: "sent", emit_id: "ep-5-a" })], "aaaaaaaa", win([
      "ep-5-a",
      "other-9-z",
    ]));
    expect(r.observedEmits).toBe(1);
    expect(r.counterGaps).toBe(0);
  });

  test("an unread transcript reports UNMEASURED, never a fabricated total", () => {
    // End-to-end on the blocker: three ids sent, transcript unreadable. The
    // pre-fix path returned counterGaps=3 and announced total loss.
    const records = [
      rec({ event: "sent", emit_id: "ep-1-a" }),
      rec({ event: "sent", emit_id: "ep-2-b" }),
      rec({ event: "sent", emit_id: "ep-3-c" }),
    ];
    const r = summarizeLoss(records, "aaaaaaaa", unread);
    expect(r.measured).toBe(false);
    expect(r.counterGaps).toBe(0);
    expect(formatLossReport(r)).toContain("COULD NOT BE MEASURED");
  });

  test("emits SENT BEFORE the window are out of frame, not missing", () => {
    // PA's ruling made concrete. A bounded tail cannot see old ids, and
    // counting them would manufacture false gaps - the costlier error, since
    // overcounting destroys the credibility of the only instrument that
    // separates real loss from noise.
    const records = [
      rec({ event: "sent", emit_id: "old-1-a", ts: "2026-09-06T01:00:00.000Z" }),
      rec({ event: "sent", emit_id: "new-2-b", ts: "2026-09-06T02:00:00.000Z" }),
    ];
    const r = summarizeLoss(records, "aaaaaaaa", win(["new-2-b"], "2026-09-06T01:30:00.000Z"));
    expect(r.counterGaps).toBe(0);
    expect(r.observedEmits).toBe(1); // denominator shrinks with the window too
  });

  test("a genuine loss INSIDE the window is still caught", () => {
    // The complement: bounding must not become a way to never report anything.
    const records = [
      rec({ event: "sent", emit_id: "new-2-b", ts: "2026-09-06T02:00:00.000Z" }),
      rec({ event: "sent", emit_id: "new-3-c", ts: "2026-09-06T02:00:01.000Z" }),
    ];
    const r = summarizeLoss(records, "aaaaaaaa", win(["new-2-b"], "2026-09-06T01:30:00.000Z"));
    expect(r.counterGaps).toBe(1);
    expect(r.observedEmits).toBe(2);
  });

  test("a clean receiver produces a report that formats to null", () => {
    const r = summarizeLoss([rec({ event: "sent", emit_id: "ep-1-a" })], "aaaaaaaa", win(["ep-1-a"]));
    expect(formatLossReport(r)).toBeNull();
  });
});
