import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { tickStaleTaskDeclaration } from "../../mcp/tools/hook_event";
import { generateId, now } from "../../mcp/utils";

// ===========================================================================
// WI f86a4d4d: the edited-file curation check moves onto the RECURRING path.
//
// Jarid (2026-09-05): "the whole point of the ... 'activity-based' nudges is to
// keep agents diligent in CRUDing everything in the orchestrator DB that they
// have context on and reason to, so the KB stays as coherent and current as
// possible as agents do ongoing work."
//
// It was previously reachable ONLY from the Stop-hook housekeeping block, which
// is gated by `stop_<sid>` and fires exactly once per session. That is the same
// defect tickStaleTask's own docblock describes and avoids: a staleness check
// inside that gate "could only ever run at the FIRST hand-back ... and would
// never fire in practice". Sharper here - at the first hand-back you have
// edited the FEWEST files, so the single firing a session gets is the one with
// the least to say. Measured in session 28e29d5d: fired once, early, reporting
// nothing, then silent through 45 turns of note-writing.
//
// A NUDGE THAT HAS ONLY EVER BEEN OBSERVED SILENT IS UNTESTED, so both
// directions are asserted here: it FIRES on the motivating case, and it stays
// SILENT on the known-negatives (nothing edited / nothing described / unchanged
// set). The last of those is the one that keeps it from becoming chrome.
// ===========================================================================

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TURNS = 30; // must track STALE_TASK_TURNS

function seedSession(db: Database) {
  db.run(
    `INSERT OR REPLACE INTO session_registry
       (session_id, started_at, last_active_at, current_task, current_task_at)
     VALUES (?, ?, ?, ?, ?)`,
    [SID, now(), now(), "PLUGIN: wiring the recurring curation nudge", now()]
  );
}

function addNote(db: Database, content: string, codeRefs: string[]): string {
  const id = generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at, code_refs, signal, superseded_by)
     VALUES (?, 'architecture', ?, NULL, '', '', 'medium', 0, ?, ?, ?, 0, NULL)`,
    [id, content, ts, ts, JSON.stringify(codeRefs)]
  );
  return id;
}

/** Simulate PostToolUse having recorded edits to these files this session. */
function recordEdits(db: Database, files: string[]) {
  db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)`,
    [`edited_files_${SID}`, files.join("\n"), now()]
  );
}

/** Take n turns of the recurring nudge; return the last output. */
function takeTurns(ctx: any, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out = tickStaleTaskDeclaration(ctx, SID);
  return out;
}

describe("edited-file curation on the RECURRING nudge (WI f86a4d4d)", () => {
  let db: Database;
  let ctx: any;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
    ctx = { db, tracker: null };
    seedSession(db);
  });

  test("FIRES: names the note describing a file edited this session", () => {
    // The motivating case. Before this change it was unreachable on this path.
    const id = addNote(db, "The reaper resolves records by subdomain", [
      "worker/src/services/dns-lease.ts",
    ]);
    recordEdits(db, ["worker/src/services/dns-lease.ts"]);

    const out = takeTurns(ctx, TURNS);

    expect(out).not.toBe("");
    expect(out).toContain("Stale-by-your-own-edit");
    expect(out).toContain(id.slice(0, 8)); // the actual row, not a principle
    expect(out).toContain("dns-lease.ts");
    expect(out).toContain("supersede_note");
  });

  test("SILENT when nothing was edited", () => {
    addNote(db, "a note about a file nobody touched", ["worker/src/routes/dns.ts"]);
    const out = takeTurns(ctx, TURNS);

    expect(out).not.toBe(""); // the RECORDS CHECKPOINT itself still fires
    expect(out).not.toContain("Stale-by-your-own-edit"); // but this section does not
  });

  test("SILENT when the edited files have no notes describing them", () => {
    recordEdits(db, ["worker/src/some/file/nobody/documented.ts"]);
    const out = takeTurns(ctx, TURNS);

    expect(out).not.toBe("");
    expect(out).not.toContain("Stale-by-your-own-edit");
  });

  test("does NOT repeat an unchanged set on the next firing", () => {
    // THE ANTI-CHROME CONTROL. `edited_files_<sid>` accumulates for the whole
    // session and is never cleared, so without the fingerprint this section
    // would re-list identical notes at every interval - which is exactly how a
    // specific nudge decays into noise (60f2fdc2).
    addNote(db, "note describing the sidecar", ["sidecar/embed_server.py"]);
    recordEdits(db, ["sidecar/embed_server.py"]);

    const first = takeTurns(ctx, TURNS);
    expect(first).toContain("Stale-by-your-own-edit");

    const second = takeTurns(ctx, TURNS); // next full interval
    expect(second).not.toBe(""); // RECORDS CHECKPOINT still fires
    expect(second).not.toContain("Stale-by-your-own-edit"); // suppressed
  });

  test("RE-FIRES when a NEW note describes a file you touched", () => {
    // Suppression must not be permanent: a changed set is precisely when it is
    // worth reading again.
    addNote(db, "first note", ["sidecar/embed_server.py"]);
    recordEdits(db, ["sidecar/embed_server.py"]);
    expect(takeTurns(ctx, TURNS)).toContain("Stale-by-your-own-edit");
    expect(takeTurns(ctx, TURNS)).not.toContain("Stale-by-your-own-edit");

    const second = addNote(db, "a SECOND note about the same file", [
      "sidecar/embed_server.py",
    ]);
    const out = takeTurns(ctx, TURNS);
    expect(out).toContain("Stale-by-your-own-edit");
    expect(out).toContain(second.slice(0, 8));
  });

  test("is still SILENT for the first 29 turns", () => {
    // Inherited control: the recurring nudge must not become per-turn chrome
    // just because a new section was added to it.
    addNote(db, "note", ["sidecar/embed_server.py"]);
    recordEdits(db, ["sidecar/embed_server.py"]);
    expect(takeTurns(ctx, TURNS - 1)).toBe("");
  });
});
