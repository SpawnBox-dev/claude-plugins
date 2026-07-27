import { describe, test, expect } from "bun:test";
import {
  detectsHistoryRewrite,
  composeHistoryRewriteText,
  detectsUncheckedPremise,
} from "../../mcp/tools/hook_event";

// ===========================================================================
// 0.30.82: history-rewriting git ops get an UNCONDITIONAL state check.
//
// Motivating incident, 2026-07-27, in PA's own words: "I nearly directed an
// --amend onto what I'd been TOLD was the tip, on the strength of a report
// rather than a `git log` I ran myself."
//
// The premise there was "your commit is still the tip" - a claim about STATE,
// carrying no count, no named tool, no backticked command. So 0.30.75's
// detector, which requires a premise marker AND a bulk/destructive marker,
// misses it entirely - while guarding one of the least reversible operations
// the fleet performs.
//
// Per the anti-pattern shipped in 0.30.81: these tests run the detector against
// the case that MOTIVATED it and confirm it FIRES, then against known-negatives
// to confirm it stays quiet. A check only ever seen returning "clean" has not
// been tested.
// ===========================================================================

describe("detectsHistoryRewrite - fires on the motivating cases", () => {
  test("the verbatim incident sequence", () => {
    // PA's actual directive, which the older detector could not see.
    expect(
      detectsHistoryRewrite("Amend the commit removing the number, replace with a scratchpad pointer.")
    ).toBe(true);
    expect(detectsHistoryRewrite("Force-push.")).toBe(true);
    expect(
      detectsHistoryRewrite("Jarid has the squash-and-force option in front of him")
    ).toBe(true);
  });

  test("PROVES the gap it was built to close", () => {
    // The old conjunction detector is blind to this exact phrasing. If this
    // ever starts returning true, this detector has become redundant - which
    // would be worth knowing, not worth silently keeping.
    const p = "Amend the commit removing the number, then force-push.";
    expect(detectsUncheckedPremise(p)).toBe(false);
    expect(detectsHistoryRewrite(p)).toBe(true);
  });

  test("covers the other rewrite verbs", () => {
    for (const p of [
      "git push --force origin main",
      "let's rebase onto main",
      "run filter-repo to purge it from history",
      "git reset --hard origin/main",
      "we should rewrite the history to drop it",
      "git commit --amend",
    ]) {
      expect(detectsHistoryRewrite(p), p).toBe(true);
    }
  });
});

describe("detectsHistoryRewrite - stays quiet on known-negatives", () => {
  test("ordinary git work does not trip it", () => {
    for (const p of [
      "commit and push the fix",
      "git log --oneline -5",
      "check git status before you start",
      "stage the changes",
      "open a PR against main",
      "",
    ]) {
      expect(detectsHistoryRewrite(p), p).toBe(false);
    }
  });

  test("merely mentioning history or a commit is not a rewrite", () => {
    expect(detectsHistoryRewrite("what does the commit history look like")).toBe(false);
    expect(detectsHistoryRewrite("read the commit message")).toBe(false);
  });
});

describe("composeHistoryRewriteText", () => {
  test("demands a first-hand read of both directions", () => {
    const t = composeHistoryRewriteText();
    expect(t).toContain("origin/main..HEAD");
    expect(t).toContain("HEAD..origin/main");
    expect(t).toContain("YOURSELF");
  });

  test("carries the two lessons that actually cost time in the incident", () => {
    const t = composeHistoryRewriteText();
    // A remote-only check passed while the value sat live in the working tree.
    expect(t).toContain("WORKING TREE");
    // And the guard that could not match the data's real format.
    expect(t).toContain("(587) 777");
  });

  test("prefers the smallest operation over a full-history rewrite", () => {
    expect(composeHistoryRewriteText()).toContain("filter-repo");
  });
});
