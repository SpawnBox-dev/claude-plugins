import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Backlog item I, open since 2026-07-27.
//
// The Stop-hook nudge opened with "Before ending:" - but the Stop hook fires at
// EVERY hand-back, and the overwhelmingly common case is pausing for the user's
// next message, not ending a session. A reader who is plainly not ending
// classifies the nudge as inapplicable, and an inapplicable nudge becomes
// chrome (anti_pattern 60f2fdc2). That is precisely how the firing that DOES
// matter gets skipped.
//
// The wording had NO guard, so the fix could silently regress to the old
// framing. This is that guard. It pins the PROPERTY (does not assert the
// session is ending) rather than an exact sentence, so the text stays editable.

const SRC = readFileSync(join(import.meta.dir, "..", "..", "mcp", "tools", "hook_event.ts"), "utf8");

/** The composed Stop-hook opener, isolated from the rest of the file. */
function stopOpener(): string {
  const i = SRC.indexOf("complete orchestrator housekeeping");
  expect(i).toBeGreaterThan(-1);
  return SRC.slice(Math.max(0, i - 200), i + 200);
}

describe("item I: the Stop nudge must not claim the session is ending", () => {
  test("it does not open with 'Before ending'", () => {
    // The reported defect, verbatim. A reader pausing for input reads this as
    // not-my-situation and learns to skip the block.
    const opener = stopOpener();
    expect(opener.includes('"Before ending:')).toBe(false);
  });

  test("it names the HAND-BACK, which is true whether pausing or ending", () => {
    expect(/Handing control back/.test(stopOpener())).toBe(true);
  });

  test("it still states that maintenance is equal-priority to capture", () => {
    // The load-bearing content of the nudge - fixing the framing must not
    // quietly drop the message the framing was wrapping.
    expect(SRC).toContain("Maintenance is equal-priority to capture");
  });

  test("it gives a reason to act NOW rather than later", () => {
    // Without a consequence the accurate framing is still ignorable: "handing
    // back" alone does not tell a reader why this hand-back matters.
    expect(/lost if this turn is your last/.test(stopOpener())).toBe(true);
  });
});
