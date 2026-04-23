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

  test("atomicity: old note unchanged when new_id doesn't exist", async () => {
    // Enable FK enforcement (matches production connection settings).
    projectDb.run("PRAGMA foreign_keys = ON");

    const old = await handleRemember(projectDb, globalDb, { content: "o", type: "decision" });

    // With R2.4 new_id validation, a bogus new_id is caught BEFORE any
    // mutation and returns a typed error rather than throwing mid-transaction.
    // Either way, the old note must be unchanged (no half-superseded state).
    const result = await handleSupersede(projectDb, globalDb, {
      old_id: old.note_id!,
      new_id: "nonexistent-replacement-id",
    });

    expect(result.superseded).toBe(false);
    expect(result.error).toContain("new_id");

    const oldRow = projectDb
      .query("SELECT superseded_by, superseded_at FROM notes WHERE id = ?")
      .get(old.note_id) as { superseded_by: string | null; superseded_at: string | null };
    expect(oldRow.superseded_by).toBeNull();
    expect(oldRow.superseded_at).toBeNull();
  });
});

describe("R2.4: supersede_note hardening", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("rejects new_id that doesn't exist in any DB", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "o", type: "decision" });
    const result = await handleSupersede(projectDb, globalDb, {
      old_id: old.note_id!,
      new_id: "truly-nonexistent-id",
    });
    expect(result.superseded).toBe(false);
    expect(result.error).toContain("new_id");
    // Old note should be unchanged (guard fired before mutation)
    const oldRow = projectDb.query("SELECT superseded_by FROM notes WHERE id = ?").get(old.note_id) as any;
    expect(oldRow.superseded_by).toBeNull();
  });

  test("rejects cross-DB supersede with typed error (old project, new routes global)", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "o", type: "decision" });
    const fresh = await handleRemember(projectDb, globalDb, { content: "user pref", type: "user_pattern" }); // user_pattern goes to global
    const result = await handleSupersede(projectDb, globalDb, {
      old_id: old.note_id!,
      new_id: fresh.note_id!,
    });
    expect(result.superseded).toBe(false);
    expect(result.error).toContain("cross");
    const oldRow = projectDb.query("SELECT superseded_by FROM notes WHERE id = ?").get(old.note_id) as any;
    expect(oldRow.superseded_by).toBeNull();
  });

  test("inline creation rejects cross-DB via type routing", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "o", type: "decision" });
    const result = await handleSupersede(projectDb, globalDb, {
      old_id: old.note_id!,
      new_content: "a user pattern observation",
      new_type: "user_pattern",
    });
    expect(result.superseded).toBe(false);
    expect(result.error).toContain("cross");
    const oldRow = projectDb.query("SELECT superseded_by FROM notes WHERE id = ?").get(old.note_id) as any;
    expect(oldRow.superseded_by).toBeNull();
  });

  test("double-supersede is idempotent (true no-op, superseded_at preserved)", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "o", type: "decision" });
    const fresh = await handleRemember(projectDb, globalDb, { content: "n", type: "decision" });

    const r1 = await handleSupersede(projectDb, globalDb, { old_id: old.note_id!, new_id: fresh.note_id! });
    expect(r1.superseded).toBe(true);
    const afterR1 = projectDb.query("SELECT superseded_at FROM notes WHERE id = ?").get(old.note_id) as any;
    expect(afterR1.superseded_at).toBeTruthy();

    await new Promise((r) => setTimeout(r, 10));
    const r2 = await handleSupersede(projectDb, globalDb, { old_id: old.note_id!, new_id: fresh.note_id! });
    expect(r2.superseded).toBe(true);
    const afterR2 = projectDb.query("SELECT superseded_at FROM notes WHERE id = ?").get(old.note_id) as any;
    expect(afterR2.superseded_at).toBe(afterR1.superseded_at); // PRESERVED on idempotent call

    const linkCount = (projectDb.query(`SELECT COUNT(*) AS c FROM links WHERE from_note_id = ? AND to_note_id = ? AND relationship = 'supersedes'`).get(fresh.note_id!, old.note_id!) as any).c;
    expect(linkCount).toBe(1);
  });

  test("rejects re-supersede with a different new_id (no chain fork)", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "o", type: "decision" });
    const x = await handleRemember(projectDb, globalDb, { content: "x", type: "decision" });
    const y = await handleRemember(projectDb, globalDb, { content: "y", type: "decision" });

    const r1 = await handleSupersede(projectDb, globalDb, { old_id: old.note_id!, new_id: x.note_id! });
    expect(r1.superseded).toBe(true);

    const r2 = await handleSupersede(projectDb, globalDb, { old_id: old.note_id!, new_id: y.note_id! });
    expect(r2.superseded).toBe(false);
    expect(r2.error).toContain("already superseded");

    // Old note still points at X, not Y
    const oldRow = projectDb.query("SELECT superseded_by FROM notes WHERE id = ?").get(old.note_id) as any;
    expect(oldRow.superseded_by).toBe(x.note_id!);

    // Only one supersedes link exists (X -> old), no Y -> old
    const linkCount = (projectDb.query(`SELECT COUNT(*) AS c FROM links WHERE to_note_id = ? AND relationship = 'supersedes'`).get(old.note_id) as any).c;
    expect(linkCount).toBe(1);
  });

  test("rejects re-supersede with inline new_content when already superseded", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "o", type: "decision" });
    const x = await handleRemember(projectDb, globalDb, { content: "x", type: "decision" });
    await handleSupersede(projectDb, globalDb, { old_id: old.note_id!, new_id: x.note_id! });

    const countBefore = (projectDb.query(`SELECT COUNT(*) AS c FROM notes`).get() as any).c;
    const r = await handleSupersede(projectDb, globalDb, {
      old_id: old.note_id!,
      new_content: "a new note that should not be created",
      new_type: "decision",
    });
    expect(r.superseded).toBe(false);
    expect(r.error).toContain("already superseded");

    // No orphan note created (rejection happened BEFORE handleRemember)
    const countAfter = (projectDb.query(`SELECT COUNT(*) AS c FROM notes`).get() as any).c;
    expect(countAfter).toBe(countBefore);
  });
});
