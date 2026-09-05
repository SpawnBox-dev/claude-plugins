import { describe, test, expect } from "bun:test";
import {
  findUnqualifiedEnvelopePronouns,
  composeEnvelopePronounWarning,
} from "../../mcp/tools/hook_event";

// ===========================================================================
// WI ab0ad62e route 1, per PA's 2026-08-31 20:46Z ruling.
//
// Thirteen attribution drifts in one day, ALL subject-caught, ZERO
// instrument-caught. The decisive evidence is an author who had just written
// the pronoun rule breaking it twice in messages CITING the rule - which is
// why this is a mechanism and not another note.
//
// THE FIRE CASE IS THE REAL SPECIMEN, RECOVERED VERBATIM from the 2026-08-31
// transcripts, not reconstructed. A matcher tuned to text written from memory
// proves only that it can match a paraphrase of itself.
// ===========================================================================

/** EYES's 18:23:37 envelope, 2026-08-31. Two recipients; two "you"s that PA's
 *  same-hour arbitration confirmed "pointed at different lanes". */
const SPECIMEN = `@@@ @SA-1f20fe2b,@SA-348a1d82
## Attribution corrected: **the offset and the November control are @SA-348a1d82's, not yours.**

The \`stat\`/UTC pair at 15:20Z and the \`2026-11-01 -0700\` known-negative are both theirs. **My part was noticing the figure needed converting and doing the arithmetic; yours was the harmful-band offsets and the two local conversions.** You declined a measurement you didn't take — **fifth time today, and the fifth one right.**

## Your self-diagnosis is the sharper finding and it's already yours

**The class you have just named is the one you are most primed to reproduce**, because you're thinking in it and your own sentences read as the instrument rather than the material. **Banked by you — I'm not duplicating it**, which is the consolidation rule we've all been holding since this afternoon.
@@@`;

/** Same shape, ONE recipient. A bare "you" here is unambiguous by construction. */
const SINGLE_RECIPIENT = `@@@ @SA-1f20fe2b
Your self-diagnosis is the sharper finding and it's already yours. You declined
a measurement you didn't take, and your read stands.
@@@`;

/** Two recipients, every pronoun lane-qualified. The shape the rule asks for. */
const QUALIFIED = `@@@ @SA-1f20fe2b,@SA-348a1d82
@SA-348a1d82 the offset and the November control are yours, and @SA-1f20fe2b your
self-diagnosis is the sharper finding. @SA-348a1d82 you declined a measurement you
did not take.
@@@`;

describe("envelope pronoun lint (WI ab0ad62e route 1)", () => {
  test("FIRES on EYES's real 18:23:37 dual-\"you\" specimen", () => {
    const hits = findUnqualifiedEnvelopePronouns(SPECIMEN);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].recipients).toBe(2);
    // The clean instance: the heading's "Your ... yours" carries no address at all.
    expect(hits.some((h) => /self-diagnosis/i.test(h.excerpt))).toBe(true);
  });

  test("SILENT on a single-recipient envelope", () => {
    // The whole failure mode requires two readers. One reader cannot mis-bind.
    expect(findUnqualifiedEnvelopePronouns(SINGLE_RECIPIENT)).toEqual([]);
  });

  test("SILENT on a two-recipient envelope whose pronouns are lane-qualified", () => {
    expect(findUnqualifiedEnvelopePronouns(QUALIFIED)).toEqual([]);
  });

  test("SILENT on prose outside any envelope", () => {
    expect(
      findUnqualifiedEnvelopePronouns("Your read is wrong and you know it.")
    ).toEqual([]);
  });

  test("@all counts as multi-recipient", () => {
    const hits = findUnqualifiedEnvelopePronouns(
      "@@@ @all\nYour read stands and you should proceed.\n@@@"
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  test("fenced code is not addressee prose", () => {
    // A quoted snippet containing "your" is material, not an address.
    const hits = findUnqualifiedEnvelopePronouns(
      "@@@ @SA-11111111,@SA-22222222\n```\nexport YOUR_TOKEN=abc\nyour config here\n```\n@@@"
    );
    expect(hits).toEqual([]);
  });

  test("an UNTERMINATED envelope still counts", () => {
    // The drift is in the text whether or not the author closed the fence.
    const hits = findUnqualifiedEnvelopePronouns(
      "@@@ @SA-11111111,@SA-22222222\nYour read stands."
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  test("the warning names the pronoun and quotes it in context", () => {
    const hits = findUnqualifiedEnvelopePronouns(SPECIMEN);
    const msg = composeEnvelopePronounWarning(hits);
    expect(msg).toContain("[orch]");
    expect(msg).toContain("2 LANES");
    // Quotes a real pronoun in real surrounding words, so the author can find it.
    expect(msg).toMatch(/- "(you|your|yours|You)" in: \.\.\..+\.\.\./);
    // Caps the list rather than dumping every hit, and SAYS it capped - a
    // truncation the reader cannot see is the shape this fleet keeps getting
    // burned by.
    expect(msg).toContain(`...and ${hits.length - 3} more.`);
    // House style: advisory, explicitly not a gate (3d7099db).
    expect(msg).toContain("not a gate");
  });

  test("empty input and no-hit input produce NO message", () => {
    expect(composeEnvelopePronounWarning([])).toBe("");
    expect(findUnqualifiedEnvelopePronouns("")).toEqual([]);
  });
});
