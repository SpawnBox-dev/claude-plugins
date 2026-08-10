import { describe, test, expect } from "bun:test";
import { markChangedRosterLines } from "../../mcp/tools/hook_event";

// Jarid: "is there a way to signal to the consumer whether or [not] its changed,
// or the records the roster is linking to have changed, and which ones?...
// having a consumer not go reread stuff it already has in context."
//
// Two of the three already existed. Block-level suppression answers "did
// anything change?" by not rendering at all - a stronger signal than a flag,
// because it costs zero tokens - and it also already prevents re-reading
// unchanged content. This file covers the part that did NOT exist: WHICH entry
// changed.
//
// Why it is worth the complexity: note 60f2fdc2 records PA reading a repeated
// advisory and concluding "by turn ten I stopped reading it. If it had ever
// changed to name a DIFFERENT item, I'd probably have missed it." A re-rendered
// 8-line roster has exactly that shape - the reader knows something moved but
// must diff the block by eye.

const P = (id: string, task: string) => `  - ${id}: ${task}`;

describe("roster delta marking", () => {
  test("a CHANGED entry is marked", () => {
    const before = markChangedRosterLines([P("aaa", "building X")].join("\n"), {});
    const after = markChangedRosterLines([P("aaa", "now building Y")].join("\n"), before.hashes);
    expect(after.text).toContain("  * aaa");
    expect(after.changed).toBe(1);
  });

  test("an UNCHANGED entry is NOT marked", () => {
    const first = markChangedRosterLines(P("aaa", "steady work"), {});
    const second = markChangedRosterLines(P("aaa", "steady work"), first.hashes);
    expect(second.text).toBe(P("aaa", "steady work"));
    expect(second.changed).toBe(0);
  });

  test("a NEW entry is NOT marked - the marker has to stay scarce", () => {
    // A newly joined session (or the first render after a compaction) has no
    // prior hash. Marking it would light up every line on first sight and the
    // marker would stop meaning anything.
    const first = markChangedRosterLines(P("aaa", "existing"), {});
    const second = markChangedRosterLines(
      [P("aaa", "existing"), P("bbb", "just joined")].join("\n"),
      first.hashes
    );
    expect(second.text).toContain("  - bbb");
    expect(second.changed).toBe(0);
  });

  test("only the changed entry is marked when several are present", () => {
    const src1 = [P("aaa", "one"), P("bbb", "two"), P("ccc", "three")].join("\n");
    const first = markChangedRosterLines(src1, {});
    const src2 = [P("aaa", "one"), P("bbb", "TWO CHANGED"), P("ccc", "three")].join("\n");
    const second = markChangedRosterLines(src2, first.hashes);
    expect(second.changed).toBe(1);
    expect(second.text).toContain("  * bbb");
    expect(second.text).toContain("  - aaa");
    expect(second.text).toContain("  - ccc");
  });

  test("A CITED RECORD CHANGING MARKS THE PEER THAT CITES IT", () => {
    // The payoff for resolve-on-render: the peer's own text is identical, but
    // the work item it points at moved. The reader should see that this lane's
    // picture changed without having to know why.
    const withPlanned = [P("aaa", "FIXER lane"), "      -> 48da0e9a [planned]: publish path"].join("\n");
    const first = markChangedRosterLines(withPlanned, {});
    const withDone = [P("aaa", "FIXER lane"), "      -> 48da0e9a [done]: publish path"].join("\n");
    const second = markChangedRosterLines(withDone, first.hashes);
    expect(second.changed).toBe(1);
    expect(second.text).toContain("  * aaa");
  });

  test("ref sub-lines are grouped with their peer, not treated as entries", () => {
    const src = [P("aaa", "lane"), "      -> 1234abcd [planned]: a thing"].join("\n");
    const out = markChangedRosterLines(src, {});
    expect(Object.keys(out.hashes)).toEqual(["aaa"]);
  });

  test("hashes are computed on UNMARKED text, so a marker cannot feed itself", () => {
    // If markers fed the hash, adding one would count as a change and the entry
    // would re-mark forever. This block renders 5-15x/turn for the prime, so a
    // feedback loop here is expensive, not theoretical.
    const first = markChangedRosterLines(P("aaa", "v1"), {});
    const second = markChangedRosterLines(P("aaa", "v2"), first.hashes);
    expect(second.text).toContain("  * aaa"); // was marked
    const third = markChangedRosterLines(P("aaa", "v2"), second.hashes);
    expect(third.changed).toBe(0); // same content -> no mark, no loop
    expect(third.text).toBe(P("aaa", "v2"));
  });

  test("a departed entry drops out of the hashes rather than lingering", () => {
    const first = markChangedRosterLines([P("aaa", "x"), P("bbb", "y")].join("\n"), {});
    const second = markChangedRosterLines(P("aaa", "x"), first.hashes);
    expect(Object.keys(second.hashes)).toEqual(["aaa"]);
  });

  test("REAL FORMAT: keys on the session id across kind-suffix and overlap variants", () => {
    // The live line is `  - <session_id>[ (kind)][ *POTENTIAL OVERLAP*]: task`.
    // All three shapes must key to the SAME peer, or a kind becoming known - or
    // an overlap marker appearing - would read as a brand-new entry and the
    // change would go unmarked. The first draft used \S+ and keyed the bare
    // form as "<id>:" while the suffixed form keyed as "<id>".
    const id = "d4db6493-a24c-4d2c-a4c6-a7321bffe5eb";
    const bare = markChangedRosterLines(`  - ${id}: FIXER lane`, {});
    expect(Object.keys(bare.hashes)).toEqual([id]);

    const kinded = markChangedRosterLines(`  - ${id} (subordinate): FIXER lane`, bare.hashes);
    expect(Object.keys(kinded.hashes)).toEqual([id]);
    expect(kinded.changed).toBe(1); // recognised as the same peer, now changed

    const overlap = markChangedRosterLines(
      `  - ${id} (subordinate) *POTENTIAL OVERLAP*: FIXER lane`,
      kinded.hashes
    );
    expect(Object.keys(overlap.hashes)).toEqual([id]);
    expect(overlap.changed).toBe(1);
  });

  test("empty input is safe", () => {
    const out = markChangedRosterLines("", {});
    expect(out.changed).toBe(0);
    expect(out.hashes).toEqual({});
  });
});
