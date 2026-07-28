import { describe, test, expect } from "bun:test";
import { supersededSuffix } from "../../mcp/tools/recall";

// ===========================================================================
// 0.36.0: the last surface that can see a self-superseded note must not
// describe it as ordinary.
//
// A self-supersede (superseded_by == own id) is invisible to every search-mode
// query, because they all filter superseded notes. Detail-mode lookup by id is
// the ONLY way it still surfaces - and it was labelling it `[SUPERSEDED by
// <id>]`, identical to a healthy retirement. Spotting the difference required
// comparing two UUIDs by eye.
//
// SA-df343a05 went looking for exactly this defect and reached for
// `lookup({id})` - the path that returns the note either way. Their result was
// genuinely clean, but the method could not have told them otherwise. That is
// the shape SA-5a433456 named: to check for a SILENT-DISAPPEARANCE defect,
// search for what SHOULD be there rather than confirming what is.
//
// supersede refuses to create this since 0.33.2, but rows from earlier builds
// persist and the fleet is still on 0.31.3 where it is live. DETECTION MUST
// OUTLIVE THE FIX - do not delete these on the grounds that the write path is
// now safe.
// ===========================================================================

const ID = "aaaaaaaa-1111-4000-8000-000000000001";
const OTHER = "bbbbbbbb-2222-4000-8000-000000000002";

describe("0.36.0: self-supersede is labelled as corruption, not retirement", () => {
  test("a healthy note gets no suffix", () => {
    expect(supersededSuffix(ID, null)).toBe("");
    expect(supersededSuffix(ID, undefined)).toBe("");
  });

  test("an ordinary supersede keeps the ordinary label", () => {
    // The common case must stay unchanged - shouting on every retired note
    // would train readers to skim the word that matters.
    const out = supersededSuffix(ID, OTHER);
    expect(out).toContain("SUPERSEDED by");
    expect(out).toContain(OTHER);
    expect(out).not.toContain("CORRUPT");
  });

  test("a SELF-supersede is called corrupt and says what it means", () => {
    const out = supersededSuffix(ID, ID);
    expect(out).toContain("CORRUPT");
    expect(out).toContain("ITSELF");
    // The consequence is the load-bearing half: a reader needs to know the
    // note is hidden from search, not merely that something is odd.
    expect(out.toLowerCase()).toContain("hidden from every search");
  });

  test("it names a repair, so the finding is actionable", () => {
    // A corruption label with no remedy leaves the reader stuck on a note they
    // now distrust and cannot fix.
    expect(supersededSuffix(ID, ID)).toContain("update_note");
  });

  test("the two cases are distinguishable WITHOUT comparing ids by eye", () => {
    // The whole defect in the old rendering: both strings looked the same
    // until you diffed two UUIDs manually.
    const self = supersededSuffix(ID, ID);
    const normal = supersededSuffix(ID, OTHER);
    expect(self).not.toBe(normal);
    expect(self.includes("CORRUPT")).not.toBe(normal.includes("CORRUPT"));
  });
});
