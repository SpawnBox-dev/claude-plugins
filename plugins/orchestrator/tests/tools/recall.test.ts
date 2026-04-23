import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRecall } from "../../mcp/tools/recall";
import { handleRemember } from "../../mcp/tools/remember";
import { handleSupersede } from "../../mcp/tools/supersede";
import { SessionTracker } from "../../mcp/engine/session_tracker";
import { generateId, now } from "../../mcp/utils";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("recall tool", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("returns matching notes for a query", async () => {
    // Seed notes
    await handleRemember(projectDb, globalDb, {
      content: "Backup snapshot engine handles incremental backups efficiently",
      type: "architecture",
      tags: "backup",
    });
    await handleRemember(projectDb, globalDb, {
      content: "Discord bot integration for server notifications",
      type: "architecture",
      tags: "discord",
    });

    const result = await handleRecall(projectDb, globalDb, {
      query: "backup snapshot",
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((r: any) => r.content.includes("backup"))).toBe(
      true
    );
    expect(result.detail).toBeNull();
  });

  test("returns empty for unrelated queries", async () => {
    await handleRemember(projectDb, globalDb, {
      content: "Backup snapshot engine handles incremental backups",
      type: "architecture",
    });

    const result = await handleRecall(projectDb, globalDb, {
      query: "kubernetes deployment helm chart",
    });

    expect(result.results.length).toBe(0);
    expect(result.message).toContain("No notes found");
  });

  test("filters by type when specified", async () => {
    await handleRemember(projectDb, globalDb, {
      content: "Backup architecture uses snapshot engine for incremental data",
      type: "architecture",
    });
    await handleRemember(projectDb, globalDb, {
      content: "Decided to use backup snapshots for data protection",
      type: "decision",
    });

    const result = await handleRecall(projectDb, globalDb, {
      query: "backup snapshot",
      type: "decision",
    });

    // All results should be decisions
    for (const r of result.results) {
      expect(r.type).toBe("decision");
    }
  });

  test("returns full note detail by ID", async () => {
    const stored = await handleRemember(projectDb, globalDb, {
      content: "Event-driven architecture for all backend services",
      type: "decision",
    });

    const result = await handleRecall(projectDb, globalDb, {
      id: stored.note_id!,
    });

    expect(result.detail).toBeTruthy();
    expect(result.detail!.id).toBe(stored.note_id!);
    expect(result.detail!.content).toBe(
      "Event-driven architecture for all backend services"
    );
    expect(result.detail!.type).toBe("decision");
    expect(Array.isArray(result.detail!.links)).toBe(true);
  });

  test("supports depth parameter for multi-hop graph traversal", async () => {
    // Create a chain: A -> B -> C via shared keywords
    await handleRemember(projectDb, globalDb, {
      content: "Backup engine design for incremental snapshot storage",
      type: "architecture",
      tags: "backup",
    });
    await handleRemember(projectDb, globalDb, {
      content: "Snapshot storage uses content-addressable blobs for backup data",
      type: "architecture",
      tags: "backup",
    });
    await handleRemember(projectDb, globalDb, {
      content: "Content-addressable blob deduplication in storage layer",
      type: "architecture",
      tags: "storage",
    });

    // Get the first note's ID
    const firstNote = projectDb
      .query("SELECT id FROM notes ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string };

    // Depth 1: only direct links
    const shallow = await handleRecall(projectDb, globalDb, {
      id: firstNote.id,
      depth: 1,
    });

    // Depth 3: multi-hop traversal
    const deep = await handleRecall(projectDb, globalDb, {
      id: firstNote.id,
      depth: 3,
    });

    // Deep traversal should find at least as many links as shallow
    expect(deep.detail!.links.length).toBeGreaterThanOrEqual(
      shallow.detail!.links.length
    );
  });

  test("handleRecall falls back to FTS5 cleanly when embeddingClient is null", async () => {
    // v0.21 introduced an optional embeddingClient param. Verify that passing
    // null doesn't break anything and produces the same results as the
    // 3-argument call signature used before the refactor.
    await handleRemember(projectDb, globalDb, {
      content: "Backup engine uses content-addressable storage",
      type: "architecture",
      tags: "backup",
    });

    const withoutClient = await handleRecall(projectDb, globalDb, {
      query: "backup content-addressable",
    });
    const withNullClient = await handleRecall(
      projectDb,
      globalDb,
      { query: "backup content-addressable" },
      null
    );

    expect(withoutClient.results.length).toBe(withNullClient.results.length);
    expect(withoutClient.results.length).toBeGreaterThanOrEqual(1);
  });

  test("lookup with session_id tracks surfaced notes", async () => {
    // Insert a note via handleRemember
    const stored = await handleRemember(projectDb, globalDb, {
      content: "Session tracking integration test for backup engine design",
      type: "architecture",
      tags: "session,tracking",
    });

    const noteId = stored.note_id!;
    expect(noteId).toBeTruthy();

    // Simulate what server.ts does: create a tracker, register session, query, log
    const tracker = new SessionTracker(projectDb);
    const sessionId = "test-session-1";

    tracker.registerSession(sessionId);
    const turn1 = tracker.nextTurn(sessionId);
    expect(turn1).toBe(1);

    // First lookup - note should not be "already_sent"
    const result1 = await handleRecall(projectDb, globalDb, {
      query: "backup engine",
    });
    expect(result1.results.length).toBeGreaterThanOrEqual(1);

    const matchedNote = result1.results.find((r: any) => r.id === noteId);
    expect(matchedNote).toBeTruthy();

    // Annotate before logging (mirrors server.ts logic)
    const ann1 = tracker.annotateResult(sessionId, noteId, turn1);
    expect(ann1.already_sent).toBe(false);
    expect(ann1.sent_turns_ago).toBeNull();

    // Log that we surfaced it
    tracker.logSurfaced(sessionId, noteId, turn1, "fresh");

    // Deposit pheromone signal (mirrors server.ts logic)
    const { depositSignal } = await import("../../mcp/engine/signal");
    depositSignal(projectDb, noteId);

    // Second lookup - same session, next turn. Note should be "already_sent"
    const turn2 = tracker.nextTurn(sessionId);
    expect(turn2).toBe(2);

    const ann2 = tracker.annotateResult(sessionId, noteId, turn2);
    expect(ann2.already_sent).toBe(true);
    expect(ann2.sent_turns_ago).toBe(1); // turn2(2) - turn1(1) = 1

    // Verify session_log has entries
    const logs = projectDb
      .query(`SELECT * FROM session_log WHERE session_id = ?`)
      .all(sessionId);
    expect(logs.length).toBe(1);

    // Verify signal was deposited
    const noteRow = projectDb
      .query(`SELECT signal FROM notes WHERE id = ?`)
      .get(noteId) as { signal: number };
    expect(noteRow.signal).toBe(1);
  });
});

describe("R1.2: NoteSummary carries updated_at and source_session", () => {
  test("recall search result includes updated_at", async () => {
    const projectDb = makeDb("project");
    const globalDb = makeDb("global");
    const ts = "2026-04-23T12:00:00Z";
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, source_session)
       VALUES ('n-1', 'decision', 'event-driven architecture for backend', 'event,driven,architecture,backend', 'test', 'medium', 0, ?, ?, 'session-abc')`,
      [ts, ts]
    );
    const result = await handleRecall(projectDb, globalDb, { query: "architecture" });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].updated_at).toBe(ts);
    expect(result.results[0].source_session).toBe("session-abc");
  });

  test("recall detail includes updated_at and source_session", async () => {
    const projectDb = makeDb("project");
    const globalDb = makeDb("global");
    const ts = "2026-04-23T12:00:00Z";
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, source_session)
       VALUES ('n-2', 'decision', 'c', 'k', 't', 'medium', 0, ?, ?, 'session-xyz')`,
      [ts, ts]
    );
    const result = await handleRecall(projectDb, globalDb, { id: "n-2" });
    expect(result.detail).toBeTruthy();
    expect(result.detail!.updated_at).toBe(ts);
    expect(result.detail!.source_session).toBe("session-xyz");
  });
});

describe("R1.4: default lookup hides superseded notes", () => {
  test("superseded note is absent from default query result", async () => {
    const projectDb = makeDb("project");
    const globalDb = makeDb("global");
    const ts = "2026-04-23T12:00:00Z";
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, superseded_by, superseded_at)
       VALUES ('old-1', 'decision', 'outdated claim', 'outdated,claim', '', 'medium', 0, ?, ?, 'new-1', ?)`,
      [ts, ts, ts]
    );
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at)
       VALUES ('new-1', 'decision', 'current truth', 'current,truth,outdated,claim', '', 'medium', 0, ?, ?)`,
      [ts, ts]
    );
    const result = await handleRecall(projectDb, globalDb, { query: "outdated" });
    const ids = result.results.map((r) => r.id);
    expect(ids).not.toContain("old-1");
  });

  test("superseded note is retrievable by explicit id lookup", async () => {
    const projectDb = makeDb("project");
    const globalDb = makeDb("global");
    const ts = "2026-04-23T12:00:00Z";
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, superseded_by, superseded_at)
       VALUES ('old-2', 'decision', 'c', 'k', '', 'medium', 0, ?, ?, 'replacement', ?)`,
      [ts, ts, ts]
    );
    const result = await handleRecall(projectDb, globalDb, { id: "old-2" });
    expect(result.detail).toBeTruthy();
    expect(result.detail!.id).toBe("old-2");
    expect(result.detail!.superseded_by).toBe("replacement");
  });

  test("include_superseded: true returns superseded notes in query", async () => {
    const projectDb = makeDb("project");
    const globalDb = makeDb("global");
    const ts = "2026-04-23T12:00:00Z";
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, superseded_by, superseded_at)
       VALUES ('old-3', 'decision', 'historical claim', 'historical,claim', '', 'medium', 0, ?, ?, 'current', ?)`,
      [ts, ts, ts]
    );
    const result = await handleRecall(projectDb, globalDb, { query: "historical", include_superseded: true } as any);
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("old-3");
  });
});

describe("R2.5: lookup include_history + supersede chain", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("default detail lookup does NOT include revisions", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "v1", type: "decision" });
    projectDb.run(
      `INSERT INTO note_revisions (id, note_id, content, context, tags, keywords, confidence, revised_at, revised_by_session)
       VALUES ('r1', ?, 'v1', null, null, null, 'medium', '2026-04-23T12:00:00Z', 'sess-1')`,
      [created.note_id!]
    );
    const result = await handleRecall(projectDb, globalDb, { id: created.note_id! });
    expect(result.detail).toBeTruthy();
    expect((result.detail as any).revisions).toBeUndefined();
  });

  test("include_history: true returns ordered revisions (oldest first)", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "current", type: "decision" });
    projectDb.run(
      `INSERT INTO note_revisions (id, note_id, content, context, tags, keywords, confidence, revised_at, revised_by_session)
       VALUES ('r1', ?, 'v1', null, null, null, 'medium', '2026-04-20T12:00:00Z', 'sess-1'),
              ('r2', ?, 'v2', null, null, null, 'medium', '2026-04-22T12:00:00Z', 'sess-1')`,
      [created.note_id!, created.note_id!]
    );
    const result = await handleRecall(projectDb, globalDb, { id: created.note_id!, include_history: true });
    expect(result.detail).toBeTruthy();
    expect(result.detail!.revisions).toBeTruthy();
    expect(result.detail!.revisions).toHaveLength(2);
    expect(result.detail!.revisions![0].content).toBe("v1");
    expect(result.detail!.revisions![1].content).toBe("v2");
  });

  test("detail view shows supersede_chain with outgoing supersedes edges", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "older", type: "decision" });
    const current = await handleRemember(projectDb, globalDb, { content: "current", type: "decision" });
    await handleSupersede(projectDb, globalDb, { old_id: old.note_id!, new_id: current.note_id! });

    const result = await handleRecall(projectDb, globalDb, { id: current.note_id! });
    expect(result.detail?.supersede_chain).toBeTruthy();
    const supersedesIds = result.detail!.supersede_chain!.supersedes.map((n) => n.id);
    expect(supersedesIds).toContain(old.note_id!);
    expect(result.detail!.supersede_chain!.superseded_by).toHaveLength(0);
  });

  test("lookup on an old note shows it is superseded_by current", async () => {
    const old = await handleRemember(projectDb, globalDb, { content: "old", type: "decision" });
    const current = await handleRemember(projectDb, globalDb, { content: "new", type: "decision" });
    await handleSupersede(projectDb, globalDb, { old_id: old.note_id!, new_id: current.note_id! });

    const result = await handleRecall(projectDb, globalDb, { id: old.note_id! });
    expect(result.detail?.supersede_chain).toBeTruthy();
    const supersededByIds = result.detail!.supersede_chain!.superseded_by.map((n) => n.id);
    expect(supersededByIds).toContain(current.note_id!);
  });
});
