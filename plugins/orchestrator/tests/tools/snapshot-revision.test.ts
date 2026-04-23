import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember } from "../../mcp/tools/remember";
import { snapshotRevision } from "../../mcp/tools/update_note_helpers";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("snapshotRevision", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("copies current row into note_revisions", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "original content", type: "decision", tags: "test,foo" });
    const revisionId = snapshotRevision(projectDb, created.note_id!, "session-abc");
    expect(revisionId).toBeTruthy();
    const rev = projectDb.query("SELECT * FROM note_revisions WHERE id = ?").get(revisionId!) as any;
    expect(rev.note_id).toBe(created.note_id!);
    expect(rev.content).toBe("original content");
    expect(rev.tags).toContain("test");
    expect(rev.revised_by_session).toBe("session-abc");
    expect(rev.revised_at).toBeTruthy();
  });

  test("returns null and writes nothing when note does not exist", () => {
    const revisionId = snapshotRevision(projectDb, "nonexistent");
    expect(revisionId).toBeNull();
    const count = (projectDb.query("SELECT COUNT(*) AS c FROM note_revisions").get() as any).c;
    expect(count).toBe(0);
  });

  test("captures keywords, context, confidence in revision", async () => {
    const created = await handleRemember(projectDb, globalDb, {
      content: "c",
      type: "decision",
      context: "some context",
    });
    snapshotRevision(projectDb, created.note_id!);
    const rev = projectDb.query("SELECT * FROM note_revisions WHERE note_id = ?").get(created.note_id!) as any;
    expect(rev.content).toBe("c");
    expect(rev.context).toBe("some context");
    expect(rev.confidence).toBe("medium");
    expect(rev.keywords).toBeTruthy();
  });

  test("multiple snapshots on same note create ordered chain", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "v1", type: "decision" });
    snapshotRevision(projectDb, created.note_id!);
    projectDb.run(`UPDATE notes SET content = 'v2' WHERE id = ?`, [created.note_id!]);
    await new Promise((r) => setTimeout(r, 5));
    snapshotRevision(projectDb, created.note_id!);
    const revs = projectDb.query("SELECT content, revised_at FROM note_revisions WHERE note_id = ? ORDER BY revised_at ASC").all(created.note_id!) as any[];
    expect(revs).toHaveLength(2);
    expect(revs[0].content).toBe("v1");
    expect(revs[1].content).toBe("v2");
  });
});
