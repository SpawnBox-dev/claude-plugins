import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember } from "../../mcp/tools/remember";
import { handleSupersede } from "../../mcp/tools/supersede";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("supersede tool", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("supersede by existing new_id marks old note and links supersedes", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "original claim about X", type: "decision" });
    const fresh = await handleRemember(projectDb, globalDb, { content: "refined claim about X", type: "decision" });

    const result = await handleSupersede(projectDb, globalDb, {
      old_id: old.note_id!,
      new_id: fresh.note_id!,
      reason: "refinement",
    });

    expect(result.superseded).toBe(true);
    expect(result.old_id).toBe(old.note_id!);
    expect(result.new_id).toBe(fresh.note_id!);

    const oldRow = projectDb.query("SELECT superseded_by, superseded_at FROM notes WHERE id = ?").get(old.note_id) as any;
    expect(oldRow.superseded_by).toBe(fresh.note_id!);
    expect(oldRow.superseded_at).toBeTruthy();

    const link = projectDb
      .query("SELECT * FROM links WHERE from_note_id = ? AND to_note_id = ? AND relationship = 'supersedes'")
      .get(fresh.note_id!, old.note_id!) as any;
    expect(link).toBeTruthy();
  });

  test("supersede with new_content creates the replacement inline", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "original", type: "decision" });

    const result = await handleSupersede(projectDb, globalDb, {
      old_id: old.note_id!,
      new_content: "updated truth",
      new_type: "decision",
    });

    expect(result.superseded).toBe(true);
    expect(result.new_id).toBeTruthy();

    const newRow = projectDb.query("SELECT * FROM notes WHERE id = ?").get(result.new_id!) as any;
    expect(newRow.content).toBe("updated truth");
    expect(newRow.type).toBe("decision");

    const oldRow = projectDb.query("SELECT superseded_by FROM notes WHERE id = ?").get(old.note_id) as any;
    expect(oldRow.superseded_by).toBe(result.new_id!);
  });

  test("supersede returns error when old_id not found", async () => {
    const result = await handleSupersede(projectDb, globalDb, {
      old_id: "nonexistent-id",
      new_content: "c",
      new_type: "decision",
    });
    expect(result.superseded).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("supersede requires either new_id or new_content+new_type", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "o", type: "decision" });
    const result = await handleSupersede(projectDb, globalDb, {
      old_id: old.note_id!,
    });
    expect(result.superseded).toBe(false);
    expect(result.error).toContain("new_id");
  });

  test("atomicity: UPDATE rolls back if link INSERT fails", async () => {
    // Enable FK enforcement (matches production connection settings) so the
    // link INSERT with a bogus new_id fails and triggers rollback of the
    // paired UPDATE on the old note.
    projectDb.run("PRAGMA foreign_keys = ON");

    const old = await handleRemember(projectDb, globalDb, { content: "o", type: "decision" });

    // Force FK failure: new_id references a note that doesn't exist anywhere.
    // handleSupersede resolves `db` to projectDb (where the old note lives),
    // so the INSERT into links with from_note_id = bogus new_id violates the
    // FK on notes(id).
    let threw = false;
    try {
      await handleSupersede(projectDb, globalDb, {
        old_id: old.note_id!,
        new_id: "nonexistent-replacement-id",
      });
    } catch {
      threw = true;
    }

    // Either the call threw (bun:sqlite FK violation propagates) or it
    // returned a non-superseded result. Either way, the UPDATE must have
    // rolled back with the INSERT, leaving the old note unchanged.
    const oldRow = projectDb
      .query("SELECT superseded_by, superseded_at FROM notes WHERE id = ?")
      .get(old.note_id) as { superseded_by: string | null; superseded_at: string | null };
    expect(oldRow.superseded_by).toBeNull();
    expect(oldRow.superseded_at).toBeNull();
    expect(threw).toBe(true);
  });
});
