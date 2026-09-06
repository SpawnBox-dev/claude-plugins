import { describe, test, expect } from "bun:test";
import { nextSeq, findSeqGaps } from "../../mcp/engine/agent_channel_emitlog";

// ===========================================================================
// PER-SENDER SEQUENCE NUMBERS (WI 6cf7437a).
//
// WHY THIS OUTRANKS EVERY OTHER INSTRUMENT WE BUILT TODAY. Each of the others
// - the emit log, the receipt, the enqueue join - takes its denominator from a
// record that SOMETHING WROTE. The actual bug was a watcher that consumed
// bytes and emitted nothing, so it wrote no record, so it could not appear in
// its own measurement. Both instruments were structurally blind to the fault
// they existed to find, and the tidy step function they produced was the shape
// of their coverage rather than the shape of the bug.
//
// A SEQUENCE GAP NEEDS NO RECORD OF THE MISSING ITEM. Holding 7, 8, 10 proves
// 9 existed and never arrived, with no join, no clock, and no cooperation from
// whatever dropped it.
//
// The arms below are mostly about NOT reporting gaps that are not there: a
// detector that cries wolf on every reload gets ignored, and this one has to
// survive exactly the event that stresses the system most.
// ===========================================================================

describe("nextSeq", () => {
  test("increments per target, independently", () => {
    const e = "epoch1";
    expect(nextSeq(e, "aaaaaaaa")).toBe("epoch1:1");
    expect(nextSeq(e, "aaaaaaaa")).toBe("epoch1:2");
    // A different sender's stream must not share a counter, or every message
    // routed to somebody else reads as a hole.
    expect(nextSeq(e, "bbbbbbbb")).toBe("epoch1:1");
    expect(nextSeq(e, "aaaaaaaa")).toBe("epoch1:3");
  });

  test("carries the epoch it was minted under", () => {
    expect(nextSeq("xyz", "cccccccc").startsWith("xyz:")).toBe(true);
  });
});

describe("findSeqGaps", () => {
  test("finds the hole - the actual detection", () => {
    const r = findSeqGaps(["e:7", "e:8", "e:10"]);
    expect(r.missing).toEqual([9]);
    expect(r.observed).toBe(3);
  });

  test("a contiguous run reports nothing", () => {
    expect(findSeqGaps(["e:1", "e:2", "e:3", "e:4"]).missing).toEqual([]);
  });

  test("A RESTART MUST NOT MANUFACTURE A GAP - the load-bearing arm", () => {
    // The counter resets with the process. Without epochs, 40,41 then 1,2 reads
    // as a 38-message catastrophe, and it would fire on EVERY reload - which is
    // both the moment this system is most stressed and the moment an operator
    // most needs to trust the signal.
    expect(findSeqGaps(["old:40", "old:41", "new:1", "new:2"]).missing).toEqual([]);
  });

  test("gaps are found WITHIN an epoch even when several are present", () => {
    const r = findSeqGaps(["a:1", "a:3", "b:5", "b:7"]);
    expect(r.missing.sort()).toEqual([2, 6]);
    expect(r.epochs.sort()).toEqual(["a", "b"]);
  });

  test("window edges are not evidence", () => {
    // Below the lowest seen means we started watching mid-stream; above the
    // highest means it has not been sent yet. Counting either fabricates loss
    // out of where we happened to start looking - the exact error behind two
    // figures retracted today.
    expect(findSeqGaps(["e:5", "e:6", "e:7"]).missing).toEqual([]);
  });

  test("duplicate delivery does not hide a gap", () => {
    // Duplicate delivery is real observed behaviour (open_thread 60c0ada6), so
    // dedupe by value rather than counting occurrences.
    const r = findSeqGaps(["e:1", "e:1", "e:3"]);
    expect(r.missing).toEqual([2]);
    expect(r.observed).toBe(2);
  });

  test("malformed or missing values are skipped, not crashed on", () => {
    const r = findSeqGaps(["e:1", "garbage", "", "e:x", "e:3"]);
    expect(r.missing).toEqual([2]);
  });

  test("an empty or single-item window is clean", () => {
    expect(findSeqGaps([]).missing).toEqual([]);
    expect(findSeqGaps(["e:42"]).missing).toEqual([]);
  });

  test("a large hole is reported in full, not just as a count", () => {
    // The specific numbers are what let someone go and recover the content
    // from the sender's transcript, which PA demonstrated is possible.
    expect(findSeqGaps(["e:1", "e:6"]).missing).toEqual([2, 3, 4, 5]);
  });
});
