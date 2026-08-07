import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { noteBadge } from "../mcp/utils";

// ===========================================================================
// 0.43.2 (ed316fcd entry Q): the lookup badge must show PRIORITY for work
// items, not the hardcoded confidence.
//
// THE INCIDENT, 2026-08-07. create_work_item hardcodes confidence="high" on
// every row, and lookup rendered confidence in the type badge for all types.
// So every work item ever created displayed "(high)" regardless of its actual
// priority, while priority - the field that orders the human's queue - was not
// in the output at all.
//
// Two experienced sessions independently read that "(high)" as priority and
// filed a priority-drift bug: "I asked for medium, the tool echoed medium, the
// stored record says high, and include_history shows zero revisions." Every
// observation was accurate. Both stored priorities were exactly as requested.
//
// WHY THIS IS A DEFECT AND NOT TWO CARELESS READERS - the clause worth keeping:
// the second session RE-VERIFIED the first's report using lookup, the same
// renderer, and got the identical misread. The verification step RAN, returned
// clean, and CONFIRMED THE ERROR. An instrument defect survives verification by
// the same instrument, so the only discriminator left was dropping below the
// renderer to query the columns directly.
//
// A supporting correlation was also offered in good faith - both items carried
// ~25 auto-links - which was real, causally irrelevant, and would have sent the
// next reader into the cascade code for nothing.
// ===========================================================================

describe("0.43.2: work items show priority, which is what orders the queue", () => {
  test("work_item renders priority/status, NOT confidence", () => {
    const badge = noteBadge({
      type: "work_item",
      confidence: "high", // hardcoded by create_work_item on every row
      priority: "medium",
      status: "planned",
    });
    expect(badge).toBe("medium/planned");
    // The exact regression: a work item whose confidence is "high" must not
    // render "high" when its priority is medium. This is the string two
    // sessions misread.
    expect(badge).not.toBe("high");
    expect(badge).not.toContain("high");
  });

  test("the real incident rows render as their writers set them", () => {
    // Verified against project.db at the time of the fix.
    expect(
      noteBadge({ type: "work_item", confidence: "high", priority: "medium", status: "proposed" })
    ).toBe("medium/proposed"); // c46fc894
    expect(
      noteBadge({ type: "work_item", confidence: "high", priority: "low", status: "proposed" })
    ).toBe("low/proposed"); // 4713c5e2
    expect(
      noteBadge({ type: "work_item", confidence: "high", priority: "high", status: "active" })
    ).toBe("high/active"); // ed316fcd - genuinely high, and still reads high
  });

  test("a genuinely-high work item is not obscured by the fix", () => {
    // The failure mode of over-correcting: if the badge stopped conveying
    // urgency, a real critical item would read the same as a backlog one.
    expect(
      noteBadge({ type: "work_item", confidence: "high", priority: "critical", status: "active" })
    ).toBe("critical/active");
  });
});

describe("0.43.2: every other type is UNCHANGED", () => {
  // The blast radius has to be exactly one type. Confidence is meaningful for
  // notes - it is set per-note and read by curation - so changing it there
  // would destroy information rather than reveal it.
  for (const type of ["decision", "convention", "anti_pattern", "insight", "architecture", "checkpoint", "tool_capability"]) {
    test(`${type} still renders confidence`, () => {
      expect(noteBadge({ type, confidence: "medium", priority: null, status: null })).toBe("medium");
      expect(noteBadge({ type, confidence: "low" })).toBe("low");
    });
  }
});

describe("0.43.2: WIRING - the renderer actually calls it", () => {
  // 0.37.0 shipped a guard COMPLETELY INERT behind thirteen green tests that
  // all exercised a pure function while the wiring was broken. Every test above
  // this line would pass on a build where server.ts still interpolates
  // `.confidence` directly and noteBadge is never called. This is the assertion
  // that would actually have caught the incident.
  const SERVER = readFileSync(join(import.meta.dir, "..", "mcp", "server.ts"), "utf8");

  test("both lookup render sites call noteBadge", () => {
    const detail = SERVER.match(/\*\*\$\{result\.detail\.type\}\*\* \(\$\{([^}]+)\}\)/);
    expect(detail).not.toBeNull();
    expect(detail![1]).toContain("noteBadge");

    const list = SERVER.match(/\[\$\{r\.type\}\/\$\{([^}]+)\}\]/);
    expect(list).not.toBeNull();
    expect(list![1]).toContain("noteBadge");
  });

  test("neither site interpolates raw confidence any more", () => {
    // The exact pre-fix strings. If either returns, the badge silently goes
    // back to showing a hardcoded value for work items.
    expect(SERVER).not.toContain("**${result.detail.type}** (${result.detail.confidence})");
    expect(SERVER).not.toContain("[${r.type}/${r.confidence}]");
  });

  test("noteBadge is imported, so the call sites resolve", () => {
    expect(SERVER).toMatch(/import\s*\{[^}]*\bnoteBadge\b[^}]*\}\s*from\s*"\.\/utils"/);
  });
});

describe("0.43.2: missing values are NAMED, never blank", () => {
  test("a work item with no priority says so explicitly", () => {
    // A blank half reads as "no priority set" when it may mean "not selected by
    // this query". That ambiguity is the exact class this change removes, so
    // reintroducing it in the fix would be self-defeating.
    expect(noteBadge({ type: "work_item", priority: null, status: "planned" })).toBe(
      "no-priority/planned"
    );
    expect(noteBadge({ type: "work_item", priority: "high", status: null })).toBe(
      "high/no-status"
    );
    expect(noteBadge({ type: "work_item" })).toBe("no-priority/no-status");
  });

  test("a note with no confidence renders 'unknown', not empty or undefined", () => {
    expect(noteBadge({ type: "decision", confidence: null })).toBe("unknown");
    expect(noteBadge({ type: "decision" })).toBe("unknown");
    // Never the literal string "undefined" / "null" leaking from a template.
    expect(noteBadge({ type: "decision" })).not.toContain("undefined");
    expect(noteBadge({ type: "decision" })).not.toContain("null");
  });
});
