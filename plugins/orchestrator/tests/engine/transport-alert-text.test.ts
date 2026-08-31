import { describe, test, expect } from "bun:test";
import { formatClientTransportAlert } from "../../mcp/engine/agent_channel";

// ===========================================================================
// 0.69.3 - THE ALERT WORDING, FINALLY PINNED (f7bc27b8).
//
// This item was filed 2026-08-27 proposing the emitter change. Four days and
// roughly eight re-derivations later the text was still byte-identical, and
// when it was finally rewritten it shipped with NO TEST - because it was
// built inline in the tick loop, so the one part of the alert every reader
// acts on was the only part nothing could assert. Hoisting it into
// formatClientTransportAlert is what makes these assertions possible.
//
// WHAT THE OLD TEXT GOT WRONG WAS A CLAIM, NOT A PHRASING. It asserted "its
// transcript has not been written to since" as a FACT ABOUT THE SUBJECT,
// while the detector only ever holds ONE QUEUED MESSAGE WITH NO DELIVERY
// RECORD. Different propositions. The strong form is what sent readers
// reaching for /mcp against a detector that was ~0-for-31 that day.
//
// AND IT SHIPPED ONLY ITS MOST EXPENSIVE CHECK. "Address it first" spends a
// peer's turn; the two free checks existed only in the KB. A reader with no
// prior exposure ran the costly one because it was the only one offered - on
// a parked fleet that pulled three sessions back onto a settled non-event
// against an explicit instruction not to.
//
// SO THE ORDERING TEST BELOW IS THE LOAD-BEARING ONE. Every other assertion
// checks that a phrase is PRESENT; that one checks the text cannot be
// reordered back into the shape that caused the harm. A phrase can be present
// and still be last, which is exactly how the old text failed.
// ===========================================================================

const SPECIMEN = {
  name: "SA-EYES-2026-08-30",
  id8: "dfde96db",
  anchor: "2026-08-31T03:23:44.000Z",
  waitMin: 1033,
};

const text = () => formatClientTransportAlert(SPECIMEN);

describe("0.69.3: client_transport_suspect wording", () => {
  describe("it must not overclaim - known vs inferred", () => {
    test("states what is KNOWN and what is merely INFERRED, separately", () => {
      expect(text()).toContain("WHAT IS KNOWN vs WHAT IS INFERRED");
      expect(text()).toContain("Inferred");
    });

    test("says outright that the inference does not follow from the evidence", () => {
      expect(text()).toContain("does not follow from the first");
    });

    test("does NOT reassert the old fact-about-the-subject claim", () => {
      // The exact sentence this item exists to remove. If it ever returns,
      // this test is the only thing standing between it and the fleet.
      expect(text()).not.toContain("its transcript has not been written to since");
      expect(text()).not.toContain("Silence after a send means it cannot RECEIVE");
    });
  });

  describe("the denominator travels with the verdict", () => {
    test("the anchor is printed, not just the elapsed figure", () => {
      expect(text()).toContain(SPECIMEN.anchor);
    });

    test("the elapsed figure is present too - both, not either", () => {
      expect(text()).toContain(String(SPECIMEN.waitMin));
    });

    test("the anchor appears with the baseline it was measured against", () => {
      expect(text()).toContain(`size baseline taken at ${SPECIMEN.anchor}`);
    });
  });

  describe("the base rate is inline, because a reader will not go look it up", () => {
    test("carries the base rate and the note ids", () => {
      expect(text()).toContain("BASE RATE");
      expect(text()).toContain("cb376ece");
      expect(text()).toContain("99c00385");
    });

    test("keeps 18747ab0's guard: a zero tally does not make THIS one false", () => {
      // Without this the base rate becomes permission to ignore the alert,
      // which is a different failure and a worse one.
      expect(text()).toContain("does not make THIS");
    });
  });

  describe("ORDERING: the free checks must precede the one that spends a peer", () => {
    test("both free checks appear BEFORE the /mcp remedy", () => {
      const t = text();
      const fromTask = t.indexOf("from_task");
      const ownContext = t.indexOf("the context you already have");
      const mcp = t.indexOf("/mcp");
      expect(fromTask).toBeGreaterThan(-1);
      expect(ownContext).toBeGreaterThan(-1);
      expect(mcp).toBeGreaterThan(-1);
      expect(fromTask).toBeLessThan(mcp);
      expect(ownContext).toBeLessThan(mcp);
    });

    test("the remedy is explicitly conditional, not the headline instruction", () => {
      expect(text()).toContain("ONLY IF BOTH ARE INCONCLUSIVE");
    });

    test("the free checks are labelled as free, so their cost is legible", () => {
      expect(text()).toContain("BEFORE YOU SPEND ANYONE'S TURN");
      expect(text()).toContain("at zero cost");
    });
  });

  describe("the two contaminated instruments are named", () => {
    test("VANTAGE: a non-PA negative is inconclusive, with the wording to use", () => {
      const t = text();
      expect(t).toContain("if you are not PA");
      expect(t).toContain("INCONCLUSIVE");
      expect(t).toContain('"I did not receive one"');
      expect(t).toContain('never "they have not posted"');
    });

    test("declared silence must not be read as confirmation", () => {
      // A lane under orders to stay quiet would otherwise have its obedience
      // scored as evidence of a transport fault.
      expect(text()).toContain("do not read contractual silence as confirmation");
    });
  });

  describe("identity and the closing caveat survive", () => {
    test("names the subject and its id8", () => {
      expect(text()).toContain(SPECIMEN.name);
      expect(text()).toContain(SPECIMEN.id8);
    });

    test("still says the subject cannot see the message", () => {
      expect(text()).toContain("cannot see this message");
    });
  });
});
