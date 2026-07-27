import { describe, test, expect } from "bun:test";
import {
  detectsGuardAuthoring,
  composeGuardAuthoringText,
  detectsVolatileValue,
  composeVolatileValueText,
  detectsHistoryRewrite,
} from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.30.85: two triggers, each from a live near-miss, each closing a gap in a
// trigger shipped earlier the SAME session.
//
// GUARD AUTHORING (SA-b14fafa3, correcting 0.30.82): the leak happened at an
// ordinary `git add` + commit + push with a guard that RAN AND PASSED. The
// rewrite only appeared afterwards as the remedy - so 0.30.82 fires when you
// are undoing the damage, and nothing fires at prevention time.
//
// VOLATILE VALUE (SA-df343a05): pricing changed mid-session; they held stale
// figures and were corrected only because a file changed underneath them. None
// of the earlier triggers fire - the asker is confident, no file is touched,
// and the domain never shifts.
//
// Per anti_pattern 04359482 these run each detector against its MOTIVATING
// case and confirm it FIRES, then known-negatives.
// ===========================================================================

describe("guard authoring - fires at the cheap moment", () => {
  test("the motivating sequence", () => {
    for (const p of [
      "write a pre-commit guard for the phone number",
      "grep the repo for the SIN before we commit",
      "check that the account number is not in the tracked files",
      "make sure the api key is removed",
      "scan for secrets in history",
      "redact the PII from that file",
    ]) {
      expect(detectsGuardAuthoring(p), p).toBe(true);
    }
  });

  test("PROVES the 0.30.82 gap: an ordinary commit is not a rewrite", () => {
    // This is the exact shape that leaked. The rewrite detector cannot see it,
    // which is precisely why this trigger exists.
    const p = "check the file is clean, then commit and push";
    expect(detectsHistoryRewrite(p)).toBe(false);
    expect(detectsGuardAuthoring(p)).toBe(true);
  });

  test("stays quiet on ordinary work", () => {
    for (const p of ["run the test suite", "read the routes file", "commit and push the fix", ""]) {
      expect(detectsGuardAuthoring(p), p).toBe(false);
    }
  });

  test("message carries the ten-second test and the real formatting failure", () => {
    const t = composeGuardAuthoringText();
    expect(t).toContain("confirm it FIRES");
    expect(t).toContain("(587) 777-0995");
    expect(t).toContain("normalise");
    // An untested "clean" is not evidence - that is the whole lesson.
    expect(t).toContain("is not evidence");
  });
});

describe("volatile values - fires where confidence outlives accuracy", () => {
  test("the motivating case: a confident pricing question", () => {
    // Not hedged, no file touched, no domain shift. Nothing else catches it.
    for (const p of [
      "how much is Pro?",
      "what's the price of the annual plan",
      "does the free tier include cloud backup",
      "what's our storage quota for Pro",
      "when does that credit expire",
      "is there a discount for the season pass",
    ]) {
      expect(detectsVolatileValue(p), p).toBe(true);
    }
  });

  test("stays quiet on non-volatile work", () => {
    for (const p of [
      "fix the failing linker test",
      "read the daemon logs",
      "rebuild dist and push",
      "",
    ]) {
      expect(detectsVolatileValue(p), p).toBe(false);
    }
  });

  test("message names the real failure mode: stale confidence", () => {
    const t = composeVolatileValueText();
    expect(t).toContain("CHANGES UNDER YOU");
    // The asking carries no warning - that is why no phrasing signal works.
    expect(t).toContain("confident question");
    // Multiple sources drift independently; say which you read.
    expect(t).toContain("CHARGED");
    expect(t).toContain("Name which one you read");
  });
});

// ===========================================================================
// 0.30.99: false-positive narrowing, self-observed 90 minutes after shipping.
//
// The volatile-value trigger fired on the phrase "fidelity limit" during a
// discussion about graph rebuilds - nothing commercial anywhere near it. In
// this codebase alone `limit` appears as link_limit, rate limit, character
// limit and time limit, so the bare term would have fired near-constantly on
// nothing. `plan` is worse: a plan of work.
//
// Both now require a commercial qualifier. The unambiguous commercial nouns
// (tier, subscription, entitlement, quota, allowance) stay bare.
// ===========================================================================
describe("volatile-value false positives (0.30.99 narrowing)", () => {
  test("does NOT fire on non-commercial uses of limit/plan", () => {
    for (const p of [
      "state the fidelity limit you found",
      "what's the link_limit default",
      "we hit a rate limit on the API",
      "there's a character limit on the field",
      "what's the plan for tomorrow",
      "the plan is to rebuild the graph first",
    ]) {
      expect(detectsVolatileValue(p), p).toBe(false);
    }
  });

  test("STILL fires on the cases that motivated the trigger", () => {
    // The regression guard: narrowing must not silence the real thing.
    for (const p of [
      "how much is Pro?",
      "what's the price of the annual plan",
      "does the free tier include cloud backup",
      "what's our storage quota for Pro",
      "when does that credit expire",
      "is there a discount for the season pass",
    ]) {
      expect(detectsVolatileValue(p), p).toBe(true);
    }
  });

  test("fires on limit/plan WHEN commercially qualified", () => {
    expect(detectsVolatileValue("what's the pricing plan")).toBe(true);
    expect(detectsVolatileValue("what's our storage quota")).toBe(true);
  });
});
