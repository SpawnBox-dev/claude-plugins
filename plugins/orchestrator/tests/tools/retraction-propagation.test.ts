import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { formatPropagationSurfaces } from "../../mcp/tools/supersede";
import { now, generateId } from "../../mcp/utils";

// ===========================================================================
// 0.33.0: A RETRACTION IS NOT DONE UNTIL EVERY SURFACE CARRYING IT IS UPDATED.
//
// THE MOTIVATING CASE (PA, 2026-07-28). A checkout retraction was applied to
// work item f8a55926, to the warden ledger, and to a checkpoint. The durable
// memory file every future session reads - polar-mor-account.md - kept the
// un-retracted version, including a flatly false claim about a Polar status
// that does not exist.
//
// Retrieval worked. Authorship worked. The correction was written correctly,
// more than once. It failed because nothing enumerates the surfaces carrying a
// claim, so "done" meant "done everywhere I thought of" - and every artifact
// the author looked at agreed the job was finished.
//
// This is a THIRD class, distinct from the two already diagnosed in 9a23c918:
// not a failure to consult prior knowledge, and not an unverified external
// claim, but a failure of COMPLETION.
//
// THE PROPERTY THESE TESTS DEFEND, above any particular wording: the block
// must never imply it has covered everything. It can prove inbound links and
// code_refs; it cannot see memory files, docs, or anything already published -
// and the memory file is precisely where the original bug lived. A checklist
// that silently omitted that category would confer the same false sense of
// completion that caused the failure, which would make it worse than nothing.
// ===========================================================================

function makeDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  return db;
}

function addNote(
  db: Database,
  opts: { id: string; type: string; content: string; superseded?: string }
) {
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id, opts.type, opts.content, null, "", opts.type, "medium", 0,
      null, null, null, ts, ts, null, opts.superseded ?? null,
    ]
  );
}

function addLink(
  db: Database,
  from: string,
  to: string,
  relationship = "related_to",
  strength = "medium"
) {
  db.run(
    `INSERT OR IGNORE INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [generateId(), from, to, relationship, strength, now()]
  );
}

const OLD = "aaaaaaaa-1111-4000-8000-000000000001";

describe("0.33.0: retraction propagation surfaces", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    addNote(db, { id: OLD, type: "decision", content: "the retracted claim" });
  });

  test("ALWAYS names the surfaces it cannot see, even with nothing else to show", () => {
    // The no-links case is the dangerous one: an empty block reads as "nothing
    // else carries this claim", which is the exact false completion signal.
    const out = formatPropagationSurfaces(db, OLD, []);
    expect(out.toLowerCase()).toContain("not reachable");
    expect(out.toLowerCase()).toContain("memory");
    expect(out.toLowerCase()).toContain("published");
  });

  test("names the memory FILES when they match - a filename gets fixed", () => {
    const out = formatPropagationSurfaces(db, OLD, [], [
      "polar-mor-account.md",
      "entitlements.md",
    ]);
    expect(out).toContain("polar-mor-account.md");
    expect(out).toContain("entitlements.md");
  });

  test("a keyword MISS is reported as a miss, not as an all-clear", () => {
    // The regression this guards: promoting "category" to "filename" must not
    // silence the reminder when the scan finds nothing. The match is keyword
    // overlap, so a paraphrase of the same claim scores zero - and paraphrase
    // is the normal case for a file written months earlier. Silence here would
    // be worst exactly for polar-mor-account.md, the file this exists for.
    const out = formatPropagationSurfaces(db, OLD, [], []);
    expect(out).toContain("MEMORY.md");
    expect(out.toLowerCase()).toContain("not an all-clear");
  });

  test("does NOT emit the keyword-miss caveat when files were actually named", () => {
    const out = formatPropagationSurfaces(db, OLD, [], ["polar-mor-account.md"]);
    expect(out.toLowerCase()).not.toContain("not an all-clear");
  });

  test("lists notes that point AT the retracted note", () => {
    addNote(db, {
      id: "bbbbbbbb-2222-4000-8000-000000000002",
      type: "insight",
      content: "restates the same claim in different words",
    });
    addLink(db, "bbbbbbbb-2222-4000-8000-000000000002", OLD);

    const out = formatPropagationSurfaces(db, OLD, []);
    expect(out).toContain("bbbbbbbb");
    expect(out).toContain("restates the same claim");
  });

  test("EXCLUDES the supersedes edge - the replacement is not a stale surface", () => {
    // The new note is by definition already correct. Listing it as something to
    // go fix is noise, and noise in a completion checklist is what gets the
    // whole block skimmed.
    addNote(db, {
      id: "cccccccc-3333-4000-8000-000000000003",
      type: "decision",
      content: "the corrected replacement",
    });
    addLink(db, "cccccccc-3333-4000-8000-000000000003", OLD, "supersedes", "strong");

    const out = formatPropagationSurfaces(db, OLD, []);
    expect(out).not.toContain("cccccccc");
  });

  test("EXCLUDES already-superseded notes - retracting them again is busywork", () => {
    addNote(db, {
      id: "dddddddd-4444-4000-8000-000000000004",
      type: "insight",
      content: "an old note already retired",
      superseded: "eeeeeeee-5555-4000-8000-000000000005",
    });
    addLink(db, "dddddddd-4444-4000-8000-000000000004", OLD);

    const out = formatPropagationSurfaces(db, OLD, []);
    expect(out).not.toContain("dddddddd");
  });

  test("surfaces the retracted note's own code_refs as places to check", () => {
    const out = formatPropagationSurfaces(db, OLD, [
      "worker/src/services/pricing.ts",
      "docs/pricing.md",
    ]);
    expect(out).toContain("worker/src/services/pricing.ts");
    expect(out).toContain("docs/pricing.md");
  });

  test("asks for an explicit verdict, so 'unchecked' cannot pass as 'fine'", () => {
    // Without this the block degrades into an FYI, and the class it exists to
    // stop is precisely someone believing they were finished.
    const out = formatPropagationSurfaces(db, OLD, []);
    expect(out.toLowerCase()).toContain("unchecked is not");
  });

  test("caps the inbound list rather than dumping a hub's whole neighbourhood", () => {
    for (let i = 0; i < 12; i++) {
      const id = `f${i}bbbbbb-6666-4000-8000-00000000000${i}`;
      addNote(db, { id, type: "insight", content: `neighbour ${i}` });
      addLink(db, id, OLD);
    }
    const out = formatPropagationSurfaces(db, OLD, []);
    const shown = (out.match(/f\db{6}/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(6);
  });
});
