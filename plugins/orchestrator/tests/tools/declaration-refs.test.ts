import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { resolveRefs, renderCompactRoster, type CompactPeer } from "../../mcp/tools/hook_event";

// WI dcc756ec - "should this be pointers instead of duplicate info?" (Jarid).
//
// MEASURED MOTIVATION: 56 distinct work-item/note ids were cited across the 7
// live declarations on 2026-08-10, and nearly every citation carried a
// hand-written summary of the record beside it. That cost two things - the
// space collision-avoidance detail needed (two sessions hit the 2000-char cap
// within minutes and both cut exactly that), and truth, because a copied
// summary describes only the moment it was pasted.
//
// So a declaration now CITES ids and the roster resolves them at render time.

function seedNote(
  db: Database,
  id: string,
  type: string,
  status: string | null,
  content: string
) {
  db.run(
    `INSERT OR REPLACE INTO notes (id, type, content, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, type, content, status, new Date().toISOString(), new Date().toISOString()]
  );
}

const WI = "40d09574-04a2-44ed-a669-2eaa08cb95d3";
const NOTE = "8349cf8d-b38c-422f-938e-08c7cab20512";

describe("resolveRefs: a pointer reads the record, it does not carry a copy", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
  });

  test("THE POINT: a work item that changes after the declaration renders its NEW status", () => {
    // This is the entire justification for the design. Nobody edits the
    // declaration; the roster simply tells the truth on the next render. A
    // pasted summary would still be claiming "planned" here forever.
    seedNote(db, WI, "work_item", "planned", "Staleness nudge has a cold-start");
    expect(resolveRefs(db, [WI])[0].status).toBe("planned");

    db.run(`UPDATE notes SET status = 'done' WHERE id = ?`, [WI]);
    expect(resolveRefs(db, [WI])[0].status).toBe("done");
  });

  test("resolves by 8-char prefix - what agents actually type", () => {
    seedNote(db, WI, "work_item", "planned", "Cold-start work item");
    const [r] = resolveRefs(db, ["40d09574"]);
    expect(r.label).toContain("Cold-start");
    expect(r.missing).toBeUndefined();
  });

  test("an unresolved id is reported, never silently dropped - and NOT called missing", () => {
    // Dropping it would make a broken pointer indistinguishable from a peer
    // that simply cited less - which is precisely the invisible-gap failure
    // this whole arc exists to remove.
    //
    // WORDING IS LOAD-BEARING (changed 2026-08-11 after a fleet review). The
    // old "(not found)" was a false statement: PA's roster was rendering it
    // over six real commits, because `refs` resolves notes and work items and
    // a commit SHA is neither. An unmatched id is hex-shaped whether it is a
    // commit or a typo, so the label must not claim to know which - it states
    // only what is actually true, that this is not a tracked record.
    const [r] = resolveRefs(db, ["deadbeef"]);
    expect(r.missing).toBe(true);
    expect(r.id8).toBe("deadbeef");
    expect(r.label).toBe("(not a tracked record)");
    expect(r.label).not.toContain("not found"); // never assert absence again
  });

  test("labels strip markdown - the roster must not render half a bold marker", () => {
    seedNote(db, NOTE, "insight", null, "**Claude plugin version bumps** need THREE edits");
    const [r] = resolveRefs(db, [NOTE]);
    expect(r.label).not.toContain("*");
    expect(r.label).toContain("Claude plugin version bumps");
  });

  test("a note renders WITHOUT a status - only work items have one", () => {
    seedNote(db, NOTE, "insight", null, "some durable knowledge");
    expect(resolveRefs(db, [NOTE])[0].status).toBeNull();
  });

  test("skips leading blank/markdown-only lines to find a real label", () => {
    seedNote(db, WI, "work_item", "planned", "\n\n###\n\nThe actual first sentence.");
    expect(resolveRefs(db, [WI])[0].label).toBe("The actual first sentence.");
  });

  test("BOUNDED: a peer citing 16 records cannot push the other lanes off the digest", () => {
    // One lane genuinely cited 16 on the day this was measured. The roster is a
    // scan-and-decide surface; an unbounded one stops being scannable, and an
    // unbounded hook payload has broken session entry before (05f072d3).
    for (let i = 0; i < 16; i++) {
      seedNote(db, `aaaaaaa${i}-0000-0000-0000-00000000000${i}`, "work_item", "planned", `item ${i}`);
    }
    const ids = Array.from({ length: 16 }, (_, i) => `aaaaaaa${i}`);
    expect(resolveRefs(db, ids).length).toBeLessThanOrEqual(4);
  });

  test("empty and whitespace ids are ignored, not resolved as missing", () => {
    expect(resolveRefs(db, ["", "   "])).toEqual([]);
  });

  test("GLOBAL FALLBACK: a cross-project note resolves instead of reading as missing", () => {
    // Knowledge lives in TWO stores. Resolving only the project db made every
    // cited global note render "(not found)" - worse than unresolved, because
    // it ASSERTS the record does not exist. And the notes most worth citing
    // across lanes (durable anti-patterns, conventions) are exactly the ones
    // kept global.
    //
    // Found against the LIVE databases, not fixtures: the first real
    // declaration cited three ids, two project-scoped ones resolved perfectly
    // and the third (60f2fdc2, a global anti-pattern note) came back MISSING.
    // Single-store fixtures could not have surfaced it.
    const globalDb = new Database(":memory:");
    applyMigrations(globalDb, "project");
    seedNote(globalDb, "60f2fdc2-cdc8-453a-8010-10761d1e32a6", "anti_pattern", null,
      "System-reminder habituation defeats static reminders");

    const [r] = resolveRefs(db, ["60f2fdc2"], globalDb);
    expect(r.missing).toBeUndefined();
    expect(r.label).toContain("habituation");
  });

  test("the PROJECT store wins when an id exists in both", () => {
    // Project knowledge is the more specific of the two; a local record that
    // shadows a global id should not be overridden by the fallback.
    seedNote(db, WI, "work_item", "in_progress", "the project copy");
    const globalDb = new Database(":memory:");
    applyMigrations(globalDb, "project");
    seedNote(globalDb, WI, "work_item", "done", "the global copy");

    const [r] = resolveRefs(db, [WI], globalDb);
    expect(r.label).toContain("project");
    expect(r.status).toBe("in_progress");
  });

  test("still reports missing when the id is in NEITHER store", () => {
    const globalDb = new Database(":memory:");
    applyMigrations(globalDb, "project");
    expect(resolveRefs(db, ["deadbeef"], globalDb)[0].missing).toBe(true);
  });
});

describe("the note size cap must never block a CORRECTION", () => {
  // Found 2026-08-11 by SA-d4db6493 in a fleet review, confirmed by execution
  // against the live KB: note 6f098939 - which carries an INERT/must-not-wire
  // SAFETY HOLD three sessions depend on - had grown to 71,948 chars and
  // refused an append. The record most needing correction had become the one
  // that could not take one, while a full `content` rewrite (the far more
  // destructive operation) remained allowed because it only checks the NEW
  // length.
  //
  // These pin the RULE, mirroring server.ts's guard, so the intent survives
  // even though the check itself lives in the tool handler.
  const CAP = 50_000;
  const wouldRefuse = (currentLen: number, appendLen: number) => {
    const projected = currentLen + 4 + 32 + appendLen;
    return projected > CAP && currentLen <= CAP;
  };

  test("REFUSES an append that pushes a note from under the cap to over it", () => {
    // The cap still does its job at the boundary - this is what stops a note
    // growing into a bad shape (decision 3b962e67).
    expect(wouldRefuse(49_000, 5_000)).toBe(true);
  });

  test("ALLOWS a correction to a note that is ALREADY over the cap", () => {
    // The real case: 71,948 chars, a small correction. Refusing this preserves
    // the wrong content and rejects the fix.
    expect(wouldRefuse(71_948, 1_400)).toBe(false);
  });

  test("ALLOWS an ordinary append well under the cap", () => {
    expect(wouldRefuse(10_000, 2_000)).toBe(false);
  });

  test("the boundary is the CURRENT length, not the projected one", () => {
    // A note exactly at the cap is still 'under' and must be held to it; one
    // char over is grandfathered. Stated explicitly because getting this
    // backwards silently re-freezes every oversized record.
    expect(wouldRefuse(CAP, 1_000)).toBe(true);
    expect(wouldRefuse(CAP + 1, 1_000)).toBe(false);
  });
});

describe("renderCompactRoster with resolved refs", () => {
  test("cited records render with live status, indented under the lane", () => {
    const peers: CompactPeer[] = [
      {
        id8: "d4db6493",
        current_task: "FIXER lane complete",
        liveness_state: "healthy",
        refs: [
          { id8: "48da0e9a", label: "publish path never freshness-checks", status: "planned" },
          { id8: "34415665", label: "relocate the elevated daemon", status: "deferred" },
        ],
      },
    ];
    const out = renderCompactRoster(peers);
    expect(out).toContain("FIXER lane complete");
    expect(out).toContain("48da0e9a [planned]: publish path never freshness-checks");
    expect(out).toContain("34415665 [deferred]: relocate the elevated daemon");
  });

  test("BACKWARD COMPATIBLE: a prose-only declaration renders exactly as before", () => {
    // Every existing declaration has no refs. If this changes, the migration
    // stops being additive and every peer's roster line churns for nothing.
    const peers: CompactPeer[] = [{ id8: "cccccccc", current_task: "VMTEST" }];
    expect(renderCompactRoster(peers)).toBe("  - SA-cccccccc: VMTEST");
  });

  test("an empty refs array renders nothing extra - no dangling arrow", () => {
    const peers: CompactPeer[] = [{ id8: "dddddddd", current_task: "LANDING", refs: [] }];
    expect(renderCompactRoster(peers)).toBe("  - SA-dddddddd: LANDING");
  });

  test("refs survive alongside a suspect liveness flag", () => {
    const peers: CompactPeer[] = [
      {
        id8: "eeeeeeee",
        current_task: null,
        liveness_state: "ingress_suspect",
        refs: [{ id8: "12345678", label: "a cited item", status: null }],
      },
    ];
    const out = renderCompactRoster(peers);
    expect(out).toContain("[ingress_suspect]");
    expect(out).toContain("(no task set)");
    expect(out).toContain("12345678: a cited item");
    expect(out).not.toContain("[null]");
  });
});
