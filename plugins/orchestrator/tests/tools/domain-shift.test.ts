import { describe, test, expect } from "bun:test";
import {
  newDomainTerms,
  isDomainShift,
  NEW_TERM_THRESHOLD,
} from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.30.80: DOMAIN shift, the class no other signal can see.
//
// Jarid: "not just a new area of the codebase. it has to be new
// concepts/ideas/domains/etc. like the google ads work for example had nothing
// to do with code and everything to do with how we were running that campaign,
// prior decisions, blah blah."
//
// That rules out every earlier trigger. Hedging and topic-shift phrases key on
// the USER's wording; first-visit-to-a-directory keys on FILE PATHS. A campaign
// strategy question touches neither - and the KB is the ONLY place that
// knowledge lives, because there is no source file to read your way into it.
// ===========================================================================

describe("newDomainTerms", () => {
  test("returns only terms the session has not worked in", () => {
    expect(newDomainTerms(["ads", "campaign", "daemon"], ["daemon", "wsl"])).toEqual([
      "ads",
      "campaign",
    ]);
  });

  test("de-duplicates within the incoming terms", () => {
    expect(newDomainTerms(["ads", "ads", "spend"], [])).toEqual(["ads", "spend"]);
  });

  test("returns nothing when the session already knows the vocabulary", () => {
    expect(newDomainTerms(["daemon", "wsl"], ["daemon", "wsl"])).toEqual([]);
  });
});

describe("isDomainShift", () => {
  const many = ["ads", "campaign", "credit", "conversion", "spend"];

  test("fires when enough NEW vocabulary arrives at once", () => {
    expect(isDomainShift({ newTerms: many, turn: 10, turnsSinceLastFire: null })).toBe(
      true
    );
  });

  test("does NOT fire on gradual drift of one or two terms", () => {
    // Drifting a word at a time is normal work, not a domain change.
    expect(
      isDomainShift({ newTerms: ["spend", "credit"], turn: 10, turnsSinceLastFire: null })
    ).toBe(false);
    expect(many.length).toBeGreaterThanOrEqual(NEW_TERM_THRESHOLD);
  });

  test("stays quiet in the opening turns, when EVERYTHING is new", () => {
    // The briefing has just covered this ground; firing here is pure noise.
    expect(isDomainShift({ newTerms: many, turn: 1, turnsSinceLastFire: null })).toBe(
      false
    );
  });

  test("de-dupes so one shift does not fire on consecutive turns", () => {
    expect(isDomainShift({ newTerms: many, turn: 10, turnsSinceLastFire: 1 })).toBe(
      false
    );
    expect(isDomainShift({ newTerms: many, turn: 10, turnsSinceLastFire: 8 })).toBe(
      true
    );
  });

  test("fires after a counter reset rather than going silent", () => {
    expect(isDomainShift({ newTerms: many, turn: 10, turnsSinceLastFire: -5 })).toBe(
      true
    );
  });

  test("the worked case: a code session pivoting to ads strategy", () => {
    const seen = ["daemon", "wsl", "docker", "backup", "restore"];
    const prompt = ["google", "ads", "campaign", "credit", "qualification", "spend"];
    const fresh = newDomainTerms(prompt, seen);
    expect(fresh.length).toBeGreaterThanOrEqual(NEW_TERM_THRESHOLD);
    expect(isDomainShift({ newTerms: fresh, turn: 12, turnsSinceLastFire: null })).toBe(
      true
    );
  });
});
