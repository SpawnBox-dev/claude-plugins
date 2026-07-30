import { describe, test, expect } from "bun:test";
import {
  extractBlockerLines,
  sameClaim,
  findRestatedBlockers,
  formatStalledClaimAdvisory,
} from "../../mcp/engine/stalled_claim";

// ===========================================================================
// 0.42.0: the hand-back gate.
//
// Jarid's directive via PA: existing struggle guidance detects only REPEATED
// FAILURE and the hook counter fires only on PostToolUseFailure, so a
// premature hand-back - no failed call, no retry loop, just fluent text saying
// someone else must do this - is invisible to the detector built for exactly
// that failure.
//
// THE FIXTURES BELOW ARE THE REAL INSTANCES, from three lanes in one day. A
// detector validated only against invented examples is the check-that-cannot-
// fail this repo keeps re-learning, so the positives are verbatim-shaped from
// what actually happened and the negatives are the cases that MUST survive.
// ===========================================================================

// --- the four real instances -----------------------------------------------

// FALSE hand-back (SA-5a433456). Carried a full day. No struggle signal at all:
// not blocked, mistaken about who could act.
const CP_5A_FIRST =
  "## Work State\nCreator spec rev 2 drafted.\n\n## Open Questions\n- server_hash far-end verification needs Jarid's machine to run the install";
const CP_5A_RESTATED =
  "## Work State\nCreator spec rev 3 drafted.\n\n## Open Questions\n- server_hash far-end verification still needs Jarid's machine to run the install";

// FALSE hand-back (SA-df343a05). Restated five times; the directory was a
// sibling of the one being searched.
const CP_DF_FIRST =
  "## Work State\nPricing comparator audited.\n\n## Open Questions\n- advertised price verified at one source of three, the file search timed out and was not retried";
const CP_DF_RESTATED =
  "## Work State\nMore comparator work.\n\n## Open Questions\n- advertised price verified at one source of three, the file search timed out and was not retried";

describe("0.42.0: fires on the real false hand-backs", () => {
  test("SA-5a433456's 'needs Jarid's machine', restated a second time", () => {
    const hits = findRestatedBlockers(CP_5A_FIRST, CP_5A_RESTATED);
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain("server_hash");
  });

  test("SA-df343a05's 'timed out and was not retried', restated", () => {
    const hits = findRestatedBlockers(CP_DF_FIRST, CP_DF_RESTATED);
    expect(hits.length).toBe(1);
  });

  test("catches the UNKNOWN form too, not just hand-backs to a human", () => {
    // df343a05's widening: a self-hand-back to UNKNOWN asserts the same thing
    // - no agent-executable route remains - and is SNEAKIER, because labelling
    // a value unknown is the humble-sounding move nobody challenges.
    const a = "## Open Questions\n- the charged price remains unknown, no route reads it";
    const b = "## Open Questions\n- the charged price remains unknown, still no route reads it";
    expect(findRestatedBlockers(a, b).length).toBe(1);
  });
});

describe("0.42.0: STAYS SILENT where it must - the half that rots if unguarded", () => {
  test("A FIRST-TIME blocker never fires - this is the whole design", () => {
    // SA-df343a05's constraint: "verified at one source of three" and "remains
    // genuinely unknown" are GOOD hygiene almost always. Keying on the phrase
    // would fire constantly on correct behaviour and become the always-on tray
    // light. Only RESTATEMENT is the signal.
    expect(findRestatedBlockers(null, CP_DF_FIRST)).toEqual([]);
    expect(findRestatedBlockers("## Work State\nUnrelated prior work.", CP_DF_FIRST)).toEqual([]);
  });

  test("a blocker that CHANGED between checkpoints does not fire", () => {
    // Progress was made and the claim was re-derived. That is the behaviour
    // being asked for, so it must not be punished.
    const before = "## Open Questions\n- cannot read the PDF, the attachment MCP returns metadata only";
    const after = "## Open Questions\n- ruled out three more mod loaders on the import path";
    expect(findRestatedBlockers(before, after)).toEqual([]);
  });

  test("an ordinary checkpoint with no blockers is silent", () => {
    const plain = "## Work State\nShipped 0.41.2 and closed the reconciliation.\n\n## Next Steps\n- run the suite";
    expect(findRestatedBlockers(plain, plain)).toEqual([]);
  });

  test("two DIFFERENT blockers in the same domain do not collide", () => {
    // The Jaccard floor has to be strict enough that adjacent-but-distinct
    // blockers are not treated as one restated claim.
    const a = "## Open Questions\n- blocked on the Cloudflare billing scope token for the invoice";
    const b = "## Open Questions\n- blocked on Jarid's go for the R2 stage-one delete list";
    expect(findRestatedBlockers(a, b)).toEqual([]);
  });

  test("short fragments are ignored - not every stray 'awaiting' is a claim", () => {
    expect(extractBlockerLines("- awaiting")).toEqual([]);
    expect(extractBlockerLines("unknown")).toEqual([]);
  });
});

describe("0.42.0: sameClaim", () => {
  test("tolerates rewording, which is how the real ones were restated", () => {
    expect(
      sameClaim(
        "server_hash far-end verification needs Jarid's machine",
        "server_hash far-end verification still needs Jarid's machine to run"
      )
    ).toBe(true);
  });

  test("separates unrelated claims", () => {
    expect(
      sameClaim("blocked on the billing scope token", "blocked on Jarid's R2 delete approval")
    ).toBe(false);
  });
});

describe("0.42.0: the advisory asks for ASSETS, not effort", () => {
  const advisory = formatStalledClaimAdvisory([{ text: "needs Jarid's machine to verify" }]);

  test("names asset re-enumeration explicitly", () => {
    // PA's framing and the reason the wording is not "try harder": a blocked
    // agent's instinct is retrying APPROACHES; the unlock is usually combining
    // two ASSETS already held. All three false instances were exactly that.
    expect(advisory.toLowerCase()).toContain("re-enumerate assets, not approaches");
    expect(advisory.toLowerCase()).toContain("authenticated sessions");
  });

  test("asks the one question that would have killed all three", () => {
    expect(advisory.toLowerCase()).toContain("what changed since i last asserted this");
  });

  test("EXPLICITLY permits a real wall - enumerate, do not forbid", () => {
    // The discriminator. Forbidding hand-backs makes agents grind forever on
    // real walls, which is the opposite failure and a worse one. PA's PDF case
    // was a TRUE hand-back and must survive this gate.
    expect(advisory.toLowerCase()).toContain("that is a fine");
    expect(advisory.toLowerCase()).toContain("routes you ruled out");
  });

  test("carries the evidence, so it reads as a finding rather than a nag", () => {
    expect(advisory).toContain("sibling");
    expect(advisory.toLowerCase()).toContain("already running on that machine");
  });

  test("empty when nothing was restated", () => {
    expect(formatStalledClaimAdvisory([])).toBe("");
  });
});
