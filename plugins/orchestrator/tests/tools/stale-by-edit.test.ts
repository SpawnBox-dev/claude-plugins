import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { findNotesDescribingEditedFiles } from "../../mcp/tools/hook_event";
import { generateId, now } from "../../mcp/utils";

// ===========================================================================
// 0.31.0: stale-by-your-own-edit.
//
// Jarid's original complaint had two halves. Retrieval got four triggers this
// session; THIS is the other half and it was the least covered - agents do not
// keep notes CURRENT as they work.
//
// The existing wrap-up asks you to curate the notes you SURFACED, which is
// keyed on what you READ. But the strongest staleness signal is what you
// CHANGED, and by construction the notes most likely to be silently wrong are
// the ones describing code you rewrote WITHOUT ever opening them.
// ===========================================================================

function makeDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  return db;
}

function addNote(
  db: Database,
  opts: { content: string; codeRefs: string[]; signal?: number; resolved?: number; superseded?: string | null }
) {
  const id = generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at, code_refs, signal, superseded_by)
     VALUES (?, 'architecture', ?, NULL, '', '', 'medium', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.content,
      opts.resolved ?? 0,
      ts,
      ts,
      JSON.stringify(opts.codeRefs),
      opts.signal ?? 0,
      opts.superseded ?? null,
    ]
  );
  return id;
}

describe("findNotesDescribingEditedFiles", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("pairs an edited file with the note describing it", () => {
    const id = addNote(db, {
      content: "The daemon owns updates and renames itself",
      codeRefs: ["src-tauri/src/bin/daemon/main.rs"],
    });

    const hits = findNotesDescribingEditedFiles(db, [
      "src-tauri/src/bin/daemon/main.rs",
    ]);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe(id);
    expect(hits[0].file).toBe("src-tauri/src/bin/daemon/main.rs");
  });

  test("finds notes the session NEVER surfaced - the whole point", () => {
    // No lookup, no briefing, no read. The edit alone is the signal.
    addNote(db, { content: "unread but now suspect", codeRefs: ["worker/src/routes/dns.ts"] });
    expect(findNotesDescribingEditedFiles(db, ["worker/src/routes/dns.ts"]).length).toBe(1);
  });

  test("ignores files with no notes - stays silent rather than nagging", () => {
    addNote(db, { content: "unrelated", codeRefs: ["a/b.ts"] });
    expect(findNotesDescribingEditedFiles(db, ["totally/different.ts"])).toEqual([]);
  });

  test("excludes superseded and resolved notes", () => {
    addNote(db, { content: "old", codeRefs: ["x/y.ts"], superseded: "some-newer-id" });
    addNote(db, { content: "closed", codeRefs: ["x/y.ts"], resolved: 1 });
    expect(findNotesDescribingEditedFiles(db, ["x/y.ts"])).toEqual([]);
  });

  test("does not repeat a note that describes two edited files", () => {
    addNote(db, { content: "spans both", codeRefs: ["p/one.ts", "p/two.ts"] });
    const hits = findNotesDescribingEditedFiles(db, ["p/one.ts", "p/two.ts"]);
    expect(hits.length).toBe(1);
  });

  test("is bounded so wrap-up cannot balloon", () => {
    for (let i = 0; i < 20; i++) {
      addNote(db, { content: `note ${i}`, codeRefs: [`f${i}.ts`] });
    }
    const files = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    expect(findNotesDescribingEditedFiles(db, files, 4).length).toBe(4);
  });

  test("ranks by signal so the hottest note surfaces first", () => {
    addNote(db, { content: "cold", codeRefs: ["s/h.ts"], signal: 1 });
    const hot = addNote(db, { content: "hot", codeRefs: ["s/h.ts"], signal: 99 });
    expect(findNotesDescribingEditedFiles(db, ["s/h.ts"], 1)[0].id).toBe(hot);
  });
});
