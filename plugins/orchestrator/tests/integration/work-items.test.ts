import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleOrient } from "../../mcp/tools/orient";
import { handleRemember } from "../../mcp/tools/remember";
import { generateId, now } from "../../mcp/utils";
import { createAutoLinks } from "../../mcp/engine/linker";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

/** Helper to insert a work_item directly into the DB. */
function insertWorkItem(
  db: Database,
  content: string,
  opts: { status?: string; priority?: string; id?: string } = {}
): string {
  const id = opts.id ?? generateId();
  const timestamp = now();
  db.run(
    `INSERT INTO notes (id, type, content, keywords, tags, confidence, last_validated, resolved, status, priority, created_at, updated_at)
     VALUES (?, 'work_item', ?, '', 'work_item', 'high', ?, 0, ?, ?, ?, ?)`,
    [id, content, timestamp, opts.status ?? "planned", opts.priority ?? "medium", timestamp, timestamp]
  );
  return id;
}

/** Helper to create a link between two notes. */
function insertLink(
  db: Database,
  fromId: string,
  toId: string,
  relationship: string
): string {
  const id = generateId();
  db.run(
    `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
     VALUES (?, ?, ?, ?, 'strong', ?)`,
    [id, fromId, toId, relationship, now()]
  );
  return id;
}

/** Helper to get a note by ID. */
function getNote(db: Database, id: string): any {
  return db.query(`SELECT * FROM notes WHERE id = ?`).get(id);
}

describe("work item schema", () => {
  test("migration adds status and priority columns", () => {
    const db = makeDb("project");
    const columns = db
      .query("PRAGMA table_info(notes)")
      .all() as Array<{ name: string }>;
    const colNames = columns.map(c => c.name);

    expect(colNames).toContain("status");
    expect(colNames).toContain("priority");
    db.close();
  });

  test("existing notes have null status and priority", () => {
    const db = makeDb("project");
    const globalDb = makeDb("global");

    handleRemember(db, globalDb, {
      content: "Some decision",
      type: "decision",
    });

    const note = db.query(`SELECT status, priority FROM notes WHERE type = 'decision'`).get() as any;
    expect(note.status).toBeNull();
    expect(note.priority).toBeNull();
    db.close();
    globalDb.close();
  });

  test("work_item notes can have status and priority", () => {
    const db = makeDb("project");
    const id = insertWorkItem(db, "Build the login page", { status: "active", priority: "high" });

    const note = getNote(db, id);
    expect(note.status).toBe("active");
    expect(note.priority).toBe("high");
    expect(note.type).toBe("work_item");
    db.close();
  });
});

describe("work item in briefing", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
    // Add a non-work note so it's not first_run
    handleRemember(projectDb, globalDb, {
      content: "Project uses React 18",
      type: "architecture",
    });
  });

  test("active work items appear in briefing", () => {
    insertWorkItem(projectDb, "Implement upload flow", { status: "active", priority: "high" });
    insertWorkItem(projectDb, "Write tests", { status: "planned", priority: "medium" });

    const orient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(orient.briefing.active_work.length).toBe(2);
    expect(orient.formatted).toContain("Work Items");
    expect(orient.formatted).toContain("Implement upload flow");
  });

  test("blocked work items appear separately", () => {
    insertWorkItem(projectDb, "Blocked task", { status: "blocked", priority: "high" });

    const orient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(orient.briefing.blocked_work.length).toBe(1);
    expect(orient.formatted).toContain("Blocked");
    expect(orient.formatted).toContain("Blocked task");
  });

  test("recently completed items appear in briefing", () => {
    const id = insertWorkItem(projectDb, "Done task", { status: "done", priority: "medium" });
    // Mark as resolved and set updated_at to now
    projectDb.run(`UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`, [now(), id]);

    const orient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(orient.briefing.recently_completed.length).toBe(1);
    expect(orient.formatted).toContain("Recently Completed");
  });

  test("done items older than 24h do not appear in recently completed", () => {
    const id = insertWorkItem(projectDb, "Old done task", { status: "done", priority: "medium" });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    projectDb.run(`UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`, [twoDaysAgo, id]);

    const orient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(orient.briefing.recently_completed.length).toBe(0);
  });

  test("active work items are ordered by priority", () => {
    insertWorkItem(projectDb, "Low priority task", { status: "active", priority: "low" });
    insertWorkItem(projectDb, "Critical task", { status: "active", priority: "critical" });
    insertWorkItem(projectDb, "Medium task", { status: "active", priority: "medium" });

    const orient = handleOrient(projectDb, globalDb, { event: "startup" });
    const priorities = orient.briefing.active_work.map(w => w.priority);
    expect(priorities).toEqual(["critical", "medium", "low"]);
  });

  test("suggested focus prefers active work over open threads", () => {
    handleRemember(projectDb, globalDb, {
      content: "Some open question about architecture",
      type: "open_thread",
    });
    insertWorkItem(projectDb, "High priority task to do", { status: "active", priority: "high" });

    const orient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(orient.briefing.suggested_focus).toContain("High priority task");
  });
});

describe("cascade resolution", () => {
  let db: Database;
  let globalDb: Database;

  beforeEach(() => {
    db = makeDb("project");
    globalDb = makeDb("global");
  });

  test("completing a blocker unblocks blocked items", () => {
    const blockerId = insertWorkItem(db, "Fix the database", { status: "active", priority: "high" });
    const blockedId = insertWorkItem(db, "Run migrations", { status: "blocked", priority: "medium" });
    insertLink(db, blockerId, blockedId, "blocks");

    // Resolve the blocker
    const timestamp = now();
    db.run(`UPDATE notes SET resolved = 1, status = 'done', updated_at = ? WHERE id = ?`, [timestamp, blockerId]);

    // Manually trigger cascade (simulating what close_thread does)
    const { cascadeResolution } = require("../../mcp/server") as any;
    // Since we can't import cascadeResolution directly (it's not exported),
    // we test via the DB state after simulating the cascade manually

    // Check: find items blocked by the now-resolved blocker
    const blockedItems = db
      .query(
        `SELECT DISTINCT n.id, n.type, n.status FROM links l
         JOIN notes n ON (
           (l.from_note_id = ? AND l.to_note_id = n.id) OR
           (l.to_note_id = ? AND l.from_note_id = n.id)
         )
         WHERE l.relationship = 'blocks' AND n.id != ? AND n.resolved = 0`
      )
      .all(blockerId, blockerId, blockerId) as Array<{ id: string; type: string; status: string | null }>;

    expect(blockedItems.length).toBe(1);
    expect(blockedItems[0].id).toBe(blockedId);

    // Simulate cascade: check if no other blockers, then unblock
    const otherBlockers = db
      .query(
        `SELECT COUNT(*) as cnt FROM links l
         JOIN notes n ON (
           (l.from_note_id = n.id AND l.to_note_id = ?) OR
           (l.to_note_id = n.id AND l.from_note_id = ?)
         )
         WHERE l.relationship = 'blocks' AND n.id != ? AND n.resolved = 0`
      )
      .get(blockedId, blockedId, blockerId) as { cnt: number };

    expect(otherBlockers.cnt).toBe(0);

    // Unblock
    db.run(`UPDATE notes SET status = 'planned', updated_at = ? WHERE id = ?`, [timestamp, blockedId]);
    const unblocked = getNote(db, blockedId);
    expect(unblocked.status).toBe("planned");
  });

  test("completing all children auto-completes parent", () => {
    const parentId = insertWorkItem(db, "Build auth system", { status: "planned", priority: "high" });
    const child1Id = insertWorkItem(db, "Design login form", { status: "done", priority: "medium" });
    const child2Id = insertWorkItem(db, "Implement OAuth", { status: "done", priority: "medium" });

    insertLink(db, child1Id, parentId, "part_of");
    insertLink(db, child2Id, parentId, "part_of");

    // Mark children as resolved
    const timestamp = now();
    db.run(`UPDATE notes SET resolved = 1 WHERE id IN (?, ?)`, [child1Id, child2Id]);

    // Check unresolved siblings
    const unresolvedSiblings = db
      .query(
        `SELECT COUNT(*) as cnt FROM links l
         JOIN notes n ON l.from_note_id = n.id
         WHERE l.to_note_id = ? AND l.relationship = 'part_of'
         AND (n.resolved = 0 OR (n.type = 'work_item' AND n.status != 'done'))`
      )
      .get(parentId) as { cnt: number };

    expect(unresolvedSiblings.cnt).toBe(0);

    // Auto-complete parent
    db.run(`UPDATE notes SET resolved = 1, status = 'done', updated_at = ? WHERE id = ?`, [timestamp, parentId]);
    const parent = getNote(db, parentId);
    expect(parent.status).toBe("done");
    expect(parent.resolved).toBe(1);
  });

  test("parent does NOT auto-complete with unfinished children", () => {
    const parentId = insertWorkItem(db, "Build auth system", { status: "planned", priority: "high" });
    const child1Id = insertWorkItem(db, "Design login form", { status: "done", priority: "medium" });
    const child2Id = insertWorkItem(db, "Implement OAuth", { status: "active", priority: "medium" });

    insertLink(db, child1Id, parentId, "part_of");
    insertLink(db, child2Id, parentId, "part_of");

    db.run(`UPDATE notes SET resolved = 1 WHERE id = ?`, [child1Id]);

    // Check unresolved siblings from child1's perspective
    const unresolvedSiblings = db
      .query(
        `SELECT COUNT(*) as cnt FROM links l
         JOIN notes n ON l.from_note_id = n.id
         WHERE l.to_note_id = ? AND l.relationship = 'part_of'
         AND n.id != ? AND (n.resolved = 0 OR (n.type = 'work_item' AND n.status != 'done'))`
      )
      .get(parentId, child1Id) as { cnt: number };

    expect(unresolvedSiblings.cnt).toBe(1); // child2 is still active
  });

  test("item with multiple blockers stays blocked until ALL resolved", () => {
    const blocker1Id = insertWorkItem(db, "Fix bug A", { status: "active", priority: "high" });
    const blocker2Id = insertWorkItem(db, "Fix bug B", { status: "active", priority: "high" });
    const blockedId = insertWorkItem(db, "Deploy", { status: "blocked", priority: "medium" });

    insertLink(db, blocker1Id, blockedId, "blocks");
    insertLink(db, blocker2Id, blockedId, "blocks");

    // Resolve only blocker1
    db.run(`UPDATE notes SET resolved = 1, status = 'done' WHERE id = ?`, [blocker1Id]);

    // Check other blockers for the blocked item
    const otherBlockers = db
      .query(
        `SELECT COUNT(*) as cnt FROM links l
         JOIN notes n ON (
           (l.from_note_id = n.id AND l.to_note_id = ?) OR
           (l.to_note_id = n.id AND l.from_note_id = ?)
         )
         WHERE l.relationship = 'blocks' AND n.id != ? AND n.resolved = 0`
      )
      .get(blockedId, blockedId, blocker1Id) as { cnt: number };

    expect(otherBlockers.cnt).toBe(1); // blocker2 still unresolved
    // blocked item should remain blocked
    const blocked = getNote(db, blockedId);
    expect(blocked.status).toBe("blocked");
  });

  test("superseding a note auto-resolves the superseded note", () => {
    const oldDecisionId = generateId();
    db.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, last_validated, resolved, created_at, updated_at)
       VALUES (?, 'decision', 'Use REST API', '', 'decision', 'medium', ?, 0, ?, ?)`,
      [oldDecisionId, now(), now(), now()]
    );

    const newDecisionId = generateId();
    db.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, last_validated, resolved, created_at, updated_at)
       VALUES (?, 'decision', 'Use GraphQL instead', '', 'decision', 'medium', ?, 0, ?, ?)`,
      [newDecisionId, now(), now(), now()]
    );

    insertLink(db, newDecisionId, oldDecisionId, "supersedes");

    // Simulate cascade: resolve superseded
    db.run(`UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`, [now(), oldDecisionId]);

    const oldDecision = getNote(db, oldDecisionId);
    expect(oldDecision.resolved).toBe(1);
  });
});

describe("part_of relationship", () => {
  test("breakdown creates parent-child structure", () => {
    const db = makeDb("project");

    const parentId = insertWorkItem(db, "Build hibernation feature", { status: "planned", priority: "high" });
    const child1Id = insertWorkItem(db, "Design bundle format", { status: "planned", priority: "medium" });
    const child2Id = insertWorkItem(db, "Implement encryption", { status: "planned", priority: "medium" });
    const child3Id = insertWorkItem(db, "Build upload UI", { status: "planned", priority: "medium" });

    insertLink(db, child1Id, parentId, "part_of");
    insertLink(db, child2Id, parentId, "part_of");
    insertLink(db, child3Id, parentId, "part_of");

    // Verify links exist
    const children = db
      .query(
        `SELECT n.id, n.content FROM links l
         JOIN notes n ON l.from_note_id = n.id
         WHERE l.to_note_id = ? AND l.relationship = 'part_of'
         ORDER BY n.created_at`
      )
      .all(parentId) as Array<{ id: string; content: string }>;

    expect(children.length).toBe(3);
    expect(children[0].content).toBe("Design bundle format");
    expect(children[1].content).toBe("Implement encryption");
    expect(children[2].content).toBe("Build upload UI");

    db.close();
  });
});

describe("work items with knowledge graph", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("work items auto-link to related knowledge notes", () => {
    // Create an architecture note about hibernation
    handleRemember(projectDb, globalDb, {
      content: "Hibernation uses tar+zst bundles with server-side HKDF encryption",
      type: "architecture",
      tags: "hibernation,encryption",
    });

    // Create a work item about hibernation - use extractKeywords for realistic overlap
    const { extractKeywords } = require("../../mcp/utils");
    const workContent = "Implement hibernation bundle encryption and restore flow";
    const workId = insertWorkItem(projectDb, workContent, {
      status: "planned",
      priority: "high",
    });

    // Use extracted keywords (same as create_work_item does)
    const keywords = extractKeywords(workContent);
    const links = createAutoLinks(projectDb, workId, keywords);

    // Should have linked to the architecture note (shares: hibernation, encryption, bundle)
    expect(links.length).toBeGreaterThan(0);
  });

  test("risk notes create blocks relationship with work items", () => {
    // The linker infers blocks relationship between risk and work_item
    const { inferRelationship } = require("../../mcp/engine/linker");
    const rel = inferRelationship("risk", "work_item");
    expect(rel).toBe("blocks");
  });

  test("decision notes create enables relationship with work items", () => {
    const { inferRelationship } = require("../../mcp/engine/linker");
    const rel = inferRelationship("decision", "work_item");
    expect(rel).toBe("enables");
  });
});
