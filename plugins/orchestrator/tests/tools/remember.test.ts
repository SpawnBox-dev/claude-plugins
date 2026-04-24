import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember, bucketLabel } from "../../mcp/tools/remember";
import type { EmbeddingClient } from "../../mcp/engine/embeddings";
import { generateId, now } from "../../mcp/utils";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("remember tool", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("stores a decision note in project DB", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      content: "Use event-driven architecture for all backend services",
      type: "decision",
      context: "Architecture discussion about backend design",
      tags: "backend,architecture",
    });

    expect(result.stored).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.note_id).toBeTruthy();

    // Verify it's in project DB
    const note = projectDb
      .query("SELECT * FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(note).toBeTruthy();
    expect(note.type).toBe("decision");
    expect(note.content).toBe(
      "Use event-driven architecture for all backend services"
    );

    // Verify NOT in global DB
    const globalNote = globalDb
      .query("SELECT * FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(globalNote).toBeNull();
  });

  test("stores user_pattern in global DB", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      content: "User prefers complete removals in one pass",
      type: "user_pattern",
    });

    expect(result.stored).toBe(true);
    expect(result.note_id).toBeTruthy();

    // Verify it's in global DB
    const note = globalDb
      .query("SELECT * FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(note).toBeTruthy();
    expect(note.type).toBe("user_pattern");

    // Verify NOT in project DB
    const projectNote = projectDb
      .query("SELECT * FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(projectNote).toBeNull();
  });

  test("detects duplicates and promotes confidence", async () => {
    const first = await handleRemember(projectDb, globalDb, {
      content: "Always use TypeScript strict mode",
      type: "convention",
    });
    expect(first.stored).toBe(true);

    const second = await handleRemember(projectDb, globalDb, {
      content: "Always use TypeScript strict mode",
      type: "convention",
    });
    expect(second.stored).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.promoted).toBe(true);
    expect(second.note_id).toBe(first.note_id);

    // Verify confidence was promoted from medium to high
    const note = projectDb
      .query("SELECT confidence FROM notes WHERE id = ?")
      .get(first.note_id!) as any;
    expect(note.confidence).toBe("high");
  });

  test("writes user_model entry for user_pattern notes", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      content: "User prefers complete removals in one pass",
      type: "user_pattern",
      context: "Observed during code refactoring session",
    });

    expect(result.stored).toBe(true);

    // Check user_model table in global DB
    const entry = globalDb
      .query("SELECT * FROM user_model WHERE observation = ?")
      .get("User prefers complete removals in one pass") as any;
    expect(entry).toBeTruthy();
    expect(entry.dimension).toBe("preference");
    expect(entry.confidence).toBe("medium");
  });

  test("auto-generates keywords", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      content: "Backup snapshot engine handles incremental backups efficiently",
      type: "architecture",
      context: "backup system design review",
    });

    expect(result.stored).toBe(true);

    const note = projectDb
      .query("SELECT keywords FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(note.keywords).toBeTruthy();
    expect(note.keywords.length).toBeGreaterThan(0);
    // Should contain meaningful words from content
    expect(note.keywords.toLowerCase()).toContain("backup");
  });

  // === v0.18 source_session plumbing regression guards ===
  //
  // These tests verify that the session_id passed into handleRemember actually
  // lands in the notes.source_session column. The cross-session discovery
  // pipeline depends on this: without source_session set, sibling sessions'
  // briefings will never surface this note under "new since your last briefing".
  //
  // Before v0.18, handleRemember did not accept session_id at all. Between
  // v0.18 and v0.19.1 we only had integration-level evidence that it worked.
  // These are the unit-level regression guards that were previously missing.

  test("writes source_session column when session_id provided", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      content: "Session-attributed decision note",
      type: "decision",
      session_id: "source-session-test-1",
    });

    expect(result.stored).toBe(true);
    const note = projectDb
      .query("SELECT source_session FROM notes WHERE id = ?")
      .get(result.note_id!) as { source_session: string | null };
    expect(note.source_session).toBe("source-session-test-1");
  });

  test("writes NULL source_session when session_id omitted", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      content: "Unattributed insight note",
      type: "insight",
    });

    expect(result.stored).toBe(true);
    const note = projectDb
      .query("SELECT source_session FROM notes WHERE id = ?")
      .get(result.note_id!) as { source_session: string | null };
    expect(note.source_session).toBeNull();
  });

  test("source_session persists through the full note insert flow", async () => {
    // Multi-note sequence from the same session. All should share source_session.
    const ids: string[] = [];
    for (const content of [
      "First thought about backup design",
      "Second thought about restore flow",
      "Third thought about hibernation encryption",
    ]) {
      const result = await handleRemember(projectDb, globalDb, {
        content,
        type: "insight",
        session_id: "multi-note-session",
      });
      expect(result.stored).toBe(true);
      ids.push(result.note_id!);
    }

    const rows = projectDb
      .query(
        `SELECT id, source_session FROM notes WHERE id IN (?, ?, ?) ORDER BY created_at ASC`
      )
      .all(ids[0], ids[1], ids[2]) as Array<{
      id: string;
      source_session: string | null;
    }>;

    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.source_session).toBe("multi-note-session");
    }
  });

  test("source_session writes to global DB for user_pattern notes", async () => {
    // user_pattern routes to global DB via GLOBAL_TYPES routing
    const result = await handleRemember(projectDb, globalDb, {
      content: "User prefers structured answers",
      type: "user_pattern",
      session_id: "global-routing-session",
    });

    expect(result.stored).toBe(true);
    // Note should be in global DB, not project DB
    const globalNote = globalDb
      .query("SELECT source_session FROM notes WHERE id = ?")
      .get(result.note_id!) as { source_session: string | null } | null;
    expect(globalNote).toBeTruthy();
    expect(globalNote!.source_session).toBe("global-routing-session");
  });
});

// Note: the R3.5b post-insert similarity alert was replaced by the R4
// pre-insert blocking gate (see "R4: forced-resolution gate" below). The
// R3.5b tests that asserted informational-alert wording on stored:true
// results are obsolete - the new behavior returns stored:false with a
// different message shape.

// ===========================================================================
// R4: forced-resolution gate
//
// The R3.5b "informational alert" after insert is replaced by a pre-insert
// BLOCKING gate. When embedding similarity >= 0.75 against an existing note
// of an alert-scope type (decision / convention / anti_pattern), note() now
// REJECTS the write and returns candidates. The caller must re-call with a
// `resolution` choosing: accept_new, update_existing, supersede_existing,
// close_existing.
//
// These tests cover each path plus graceful degradation (no embedding client,
// types outside alert scope).
// ===========================================================================
describe("R4: forced-resolution gate", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  function makeMockClient(vector: Float32Array): EmbeddingClient {
    return {
      embed: async (_texts: string[]) => [vector],
    } as unknown as EmbeddingClient;
  }

  function seedEmbedding(db: Database, noteId: string, vector: Float32Array) {
    const blob = Buffer.from(vector.buffer);
    db.run(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`,
      [noteId, blob, "bge-m3", new Date().toISOString()]
    );
  }

  function insertPriorNote(
    db: Database,
    opts: { id: string; type: string; content: string }
  ) {
    const ts = now();
    db.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.id,
        opts.type,
        opts.content,
        null,
        "",
        opts.type,
        "medium",
        0,
        null,
        null,
        null,
        ts,
        ts,
        null,
      ]
    );
  }

  test("no near-duplicate candidates: stores normally without resolution", async () => {
    // No prior embedded notes. Even with an embedding client, no candidates
    // => gate does not fire, insert proceeds.
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "decision",
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(true);
    expect(result.blocked_on_resolution).toBeUndefined();
    expect(result.note_id).toBeTruthy();
  });

  test("candidates exist, no resolution: returns blocked_on_resolution", async () => {
    // Seed a near-duplicate decision with matching embedding.
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-block-1",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "prior-block-1", queryVec);

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "decision",
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(false);
    expect(result.blocked_on_resolution).toBe(true);
    expect(result.note_id).toBeNull();
    expect(result.candidates).toBeTruthy();
    expect(result.candidates!.length).toBeGreaterThan(0);
    expect(result.candidates![0].id).toBe("prior-block-1");

    // Message must guide the caller.
    expect(result.message).toContain("Near-duplicate detected");
    expect(result.message).toContain("Review before choosing resolution");
    expect(result.message).toContain("accept_new");
    expect(result.message).toContain("update_existing");
    expect(result.message).toContain("supersede_existing");
    expect(result.message).toContain("close_existing");
    expect(result.message).toContain("prior-block-1");

    // Verify NO new note was inserted.
    const count = projectDb.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number };
    expect(count.cnt).toBe(1); // only the seeded prior note
  });

  test("resolution: accept_new proceeds with normal insert despite candidates", async () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-accept-1",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "prior-accept-1", queryVec);

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "decision",
        resolution: { action: "accept_new" },
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(true);
    expect(result.blocked_on_resolution).toBeUndefined();
    expect(result.note_id).toBeTruthy();
    expect(result.message).toContain("accept_new");

    // New note exists; prior note still exists unchanged.
    const count = projectDb.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number };
    expect(count.cnt).toBe(2);

    const prior = projectDb.query("SELECT superseded_by, resolved FROM notes WHERE id = ?")
      .get("prior-accept-1") as { superseded_by: string | null; resolved: number };
    expect(prior.superseded_by).toBeNull();
    expect(prior.resolved).toBe(0);
  });

  test("resolution: update_existing appends to target, does not create new note", async () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-update-1",
      type: "decision",
      content: "original decision content",
    });
    seedEmbedding(projectDb, "prior-update-1", queryVec);

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "additional observation that refines the decision",
        type: "decision",
        resolution: { action: "update_existing", target_id: "prior-update-1" },
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(false);
    expect(result.note_id).toBe("prior-update-1"); // refers to target
    expect(result.message).toContain("Appended");
    expect(result.message).toContain("prior-update-1");

    // Note count unchanged.
    const count = projectDb.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number };
    expect(count.cnt).toBe(1);

    // Target content now contains the append.
    const target = projectDb.query("SELECT content FROM notes WHERE id = ?")
      .get("prior-update-1") as { content: string };
    expect(target.content).toContain("original decision content");
    expect(target.content).toContain("additional observation that refines the decision");
    expect(target.content).toContain("---"); // appendToNoteContent timestamp separator
  });

  test("resolution: supersede_existing creates new and supersedes target", async () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-super-1",
      type: "decision",
      content: "stale decision content",
    });
    seedEmbedding(projectDb, "prior-super-1", queryVec);

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "updated replacement decision",
        type: "decision",
        resolution: {
          action: "supersede_existing",
          target_id: "prior-super-1",
          reason: "old version is outdated",
        },
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(true);
    expect(result.note_id).toBeTruthy();
    expect(result.note_id).not.toBe("prior-super-1");
    expect(result.message).toContain("superseded");
    expect(result.message).toContain("old version is outdated");

    // New note exists.
    const newNote = projectDb.query("SELECT content FROM notes WHERE id = ?")
      .get(result.note_id!) as { content: string } | null;
    expect(newNote).toBeTruthy();
    expect(newNote!.content).toBe("updated replacement decision");

    // Target is marked superseded.
    const target = projectDb.query("SELECT superseded_by, superseded_at FROM notes WHERE id = ?")
      .get("prior-super-1") as { superseded_by: string | null; superseded_at: string | null };
    expect(target.superseded_by).toBe(result.note_id);
    expect(target.superseded_at).toBeTruthy();

    // Link in graph.
    const link = projectDb.query(
      `SELECT relationship FROM links WHERE from_note_id = ? AND to_note_id = ?`
    ).get(result.note_id!, "prior-super-1") as { relationship: string } | null;
    expect(link).toBeTruthy();
    expect(link!.relationship).toBe("supersedes");
  });

  test("resolution: close_existing creates new and closes target", async () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-close-1",
      type: "decision",
      content: "decision being closed out",
    });
    seedEmbedding(projectDb, "prior-close-1", queryVec);

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "final follow-up decision",
        type: "decision",
        resolution: {
          action: "close_existing",
          target_id: "prior-close-1",
          reason: "resolved by the new note",
        },
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(true);
    expect(result.note_id).toBeTruthy();
    expect(result.note_id).not.toBe("prior-close-1");
    expect(result.message).toContain("closed target");
    expect(result.message).toContain("resolved by the new note");

    // New note exists.
    const newNote = projectDb.query("SELECT id FROM notes WHERE id = ?")
      .get(result.note_id!) as { id: string } | null;
    expect(newNote).toBeTruthy();

    // Target is resolved.
    const target = projectDb.query("SELECT resolved, status, type FROM notes WHERE id = ?")
      .get("prior-close-1") as { resolved: number; status: string | null; type: string };
    expect(target.resolved).toBe(1);
  });

  test("resolution: close_existing on work_item also flips status to done", async () => {
    // Seed an embedded decision (alert-scope) so the gate has a candidate,
    // plus a separate work_item that we'll target for close. Use
    // keyword-disjoint content so Jaccard dedup doesn't intercept.
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-dec-gate",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "prior-dec-gate", queryVec);

    const workId = "work-to-close";
    const ts = now();
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session)
       VALUES (?, 'work_item', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [workId, "mu nu xi omicron", null, "", "work_item", "medium", 0, "in_progress", null, null, ts, ts, null]
    );

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "decision",
        resolution: {
          action: "close_existing",
          target_id: workId,
        },
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(true);
    const target = projectDb.query("SELECT resolved, status FROM notes WHERE id = ?")
      .get(workId) as { resolved: number; status: string | null };
    expect(target.resolved).toBe(1);
    expect(target.status).toBe("done");
  });

  test("types outside SIMILARITY_ALERT_TYPES bypass gate (insight)", async () => {
    // Seed an embedded insight. Even with high-similarity vector, insight
    // is not in alert scope so the gate does NOT fire.
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-insight-1",
      type: "insight",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "prior-insight-1", queryVec);

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "insight",
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(true);
    expect(result.blocked_on_resolution).toBeUndefined();
    expect(result.note_id).toBeTruthy();
  });

  test("no embedding client: gate does not fire, no alert", async () => {
    // Seed a prior decision but DO NOT pass an embedding client. Without
    // the client, no similarity computation happens at all - graceful
    // degradation matches prior behavior.
    insertPriorNote(projectDb, {
      id: "prior-noclient-1",
      type: "decision",
      content: "alpha epsilon theta iota",
    });

    const result = await handleRemember(projectDb, globalDb, {
      content: "omega kappa sigma lambda",
      type: "decision",
    });

    expect(result.stored).toBe(true);
    expect(result.blocked_on_resolution).toBeUndefined();
    expect(result.note_id).toBeTruthy();
    // Post-insert alert should be gone - R4 replaces it with the pre-insert gate.
    expect(result.message).not.toContain("Possibly related existing notes");
  });

  test("update_existing without target_id returns clear error, no insert", async () => {
    // Edge case: caller chose update_existing but forgot target_id. Should
    // return an actionable error, not crash, and not insert anything.
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-missing-target",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "prior-missing-target", queryVec);

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "decision",
        resolution: { action: "update_existing" }, // no target_id
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(false);
    expect(result.note_id).toBeNull();
    expect(result.message).toContain("target_id");

    // No new note created.
    const count = projectDb.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  test("supersede_existing with nonexistent target_id returns clear error, no insert", async () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-exists",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "prior-exists", queryVec);

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "decision",
        resolution: { action: "supersede_existing", target_id: "does-not-exist" },
      },
      makeMockClient(queryVec)
    );

    expect(result.stored).toBe(false);
    expect(result.note_id).toBeNull();
    expect(result.message).toContain("not found");

    // No new note created.
    const count = projectDb.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });
});

// ===========================================================================
// R4.1: candidate rank buckets in gate message
//
// R4's gate at the 0.75 threshold surfaces candidates spanning a wide
// semantic neighborhood. R4.1 makes the rank bucket the PROMINENT visual
// marker so agents can tell "clearly the same knowledge" from "adjacent but
// different" at a glance. Three buckets:
//   - [HIGH MATCH]     (>= 0.95)
//   - [LIKELY RELATED] (0.85 - 0.94)
//   - [ADJACENT]       (0.75 - 0.84)
// The gate message also gains a "Guidance by match strength" block telling
// the agent which resolution action is typical for each bucket.
// ===========================================================================
describe("R4.1: candidate rank buckets in gate message", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  // Craft a Float32Array whose cosine similarity against [1, 0] equals
  // exactly `targetSim` (up to float precision). Using the unit identity:
  // cos([1,0], [x,y]) = x/sqrt(x^2 + y^2). Pick x=targetSim, y=sqrt(1 - x^2).
  function vectorWithSimilarity(targetSim: number): Float32Array {
    const x = targetSim;
    const y = Math.sqrt(Math.max(0, 1 - targetSim * targetSim));
    return new Float32Array([x, y]);
  }

  function makeMockClient(vector: Float32Array): EmbeddingClient {
    return {
      embed: async (_texts: string[]) => [vector],
    } as unknown as EmbeddingClient;
  }

  function seedEmbedding(db: Database, noteId: string, vector: Float32Array) {
    const blob = Buffer.from(vector.buffer);
    db.run(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`,
      [noteId, blob, "bge-m3", new Date().toISOString()]
    );
  }

  function insertPriorNote(
    db: Database,
    opts: { id: string; type: string; content: string }
  ) {
    const ts = now();
    db.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.id,
        opts.type,
        opts.content,
        null,
        "",
        opts.type,
        "medium",
        0,
        null,
        null,
        null,
        ts,
        ts,
        null,
      ]
    );
  }

  // --- Unit: bucketLabel directly --------------------------------------------

  test("bucketLabel returns HIGH MATCH for 0.95+", () => {
    expect(bucketLabel(0.95)).toBe("HIGH MATCH");
    expect(bucketLabel(0.97)).toBe("HIGH MATCH");
    expect(bucketLabel(0.99)).toBe("HIGH MATCH");
    expect(bucketLabel(1.0)).toBe("HIGH MATCH");
  });

  test("bucketLabel returns LIKELY RELATED for 0.85 - 0.949", () => {
    expect(bucketLabel(0.85)).toBe("LIKELY RELATED");
    expect(bucketLabel(0.87)).toBe("LIKELY RELATED");
    expect(bucketLabel(0.94)).toBe("LIKELY RELATED");
    expect(bucketLabel(0.9499)).toBe("LIKELY RELATED");
  });

  test("bucketLabel returns ADJACENT for 0.75 - 0.849", () => {
    expect(bucketLabel(0.75)).toBe("ADJACENT");
    expect(bucketLabel(0.79)).toBe("ADJACENT");
    expect(bucketLabel(0.84)).toBe("ADJACENT");
    expect(bucketLabel(0.8499)).toBe("ADJACENT");
  });

  // --- Integration: rendered gate message shape ------------------------------

  test("candidate at 95%+ renders with HIGH MATCH prefix", async () => {
    // Query vector is [1, 0]. Seed prior note's embedding to a vector with
    // cosine similarity ~0.97 vs the query.
    const queryVec = new Float32Array([1, 0]);
    insertPriorNote(projectDb, {
      id: "high-match-1",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "high-match-1", vectorWithSimilarity(0.97));

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "decision",
      },
      makeMockClient(queryVec)
    );

    expect(result.blocked_on_resolution).toBe(true);
    expect(result.message).toContain("[HIGH MATCH ");
    expect(result.message).toContain("high-match-1");
    // Must not falsely label it with a lower bucket.
    expect(result.message).not.toContain("[LIKELY RELATED ");
    expect(result.message).not.toContain("[ADJACENT ");
  });

  test("candidate at 85-94% renders with LIKELY RELATED prefix", async () => {
    const queryVec = new Float32Array([1, 0]);
    insertPriorNote(projectDb, {
      id: "likely-related-1",
      type: "convention",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "likely-related-1", vectorWithSimilarity(0.88));

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "convention",
      },
      makeMockClient(queryVec)
    );

    expect(result.blocked_on_resolution).toBe(true);
    expect(result.message).toContain("[LIKELY RELATED ");
    expect(result.message).toContain("likely-related-1");
    expect(result.message).not.toContain("[HIGH MATCH ");
    expect(result.message).not.toContain("[ADJACENT ");
  });

  test("candidate at 75-84% renders with ADJACENT prefix", async () => {
    const queryVec = new Float32Array([1, 0]);
    insertPriorNote(projectDb, {
      id: "adjacent-1",
      type: "anti_pattern",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "adjacent-1", vectorWithSimilarity(0.79));

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "anti_pattern",
      },
      makeMockClient(queryVec)
    );

    expect(result.blocked_on_resolution).toBe(true);
    expect(result.message).toContain("[ADJACENT ");
    expect(result.message).toContain("adjacent-1");
    expect(result.message).not.toContain("[HIGH MATCH ");
    expect(result.message).not.toContain("[LIKELY RELATED ");
  });

  test("guidance block is included when gate fires", async () => {
    const queryVec = new Float32Array([1, 0]);
    insertPriorNote(projectDb, {
      id: "guidance-1",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "guidance-1", vectorWithSimilarity(0.88));

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "decision",
      },
      makeMockClient(queryVec)
    );

    expect(result.blocked_on_resolution).toBe(true);
    expect(result.message).toContain("Guidance by match strength");
    expect(result.message).toContain("HIGH MATCH (95%+)");
    expect(result.message).toContain("LIKELY RELATED (85-94%)");
    expect(result.message).toContain("ADJACENT (75-84%)");
    // The four resolution options still render verbatim.
    expect(result.message).toContain("accept_new");
    expect(result.message).toContain("update_existing");
    expect(result.message).toContain("supersede_existing");
    expect(result.message).toContain("close_existing");
  });

  test("candidates are sorted descending by similarity", async () => {
    // Seed three candidates at varying similarity. After sorting, the
    // message should list HIGH MATCH first, LIKELY RELATED second,
    // ADJACENT third - regardless of insertion order.
    const queryVec = new Float32Array([1, 0]);
    insertPriorNote(projectDb, {
      id: "sort-adj",
      type: "decision",
      content: "adjacent content",
    });
    insertPriorNote(projectDb, {
      id: "sort-high",
      type: "decision",
      content: "high-match content",
    });
    insertPriorNote(projectDb, {
      id: "sort-likely",
      type: "decision",
      content: "likely-related content",
    });
    seedEmbedding(projectDb, "sort-adj", vectorWithSimilarity(0.79));
    seedEmbedding(projectDb, "sort-high", vectorWithSimilarity(0.97));
    seedEmbedding(projectDb, "sort-likely", vectorWithSimilarity(0.88));

    const result = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "omega kappa sigma lambda",
        type: "decision",
      },
      makeMockClient(queryVec)
    );

    expect(result.blocked_on_resolution).toBe(true);
    expect(result.candidates).toBeTruthy();
    // At most top-3 surface; all three should make the cut.
    expect(result.candidates!.length).toBe(3);
    expect(result.candidates![0].id).toBe("sort-high");
    expect(result.candidates![1].id).toBe("sort-likely");
    expect(result.candidates![2].id).toBe("sort-adj");

    // In the rendered message, HIGH MATCH's position < LIKELY RELATED's
    // position < ADJACENT's position (strict ordering).
    const msg = result.message;
    const posHigh = msg.indexOf("[HIGH MATCH ");
    const posLikely = msg.indexOf("[LIKELY RELATED ");
    const posAdj = msg.indexOf("[ADJACENT ");
    expect(posHigh).toBeGreaterThan(-1);
    expect(posLikely).toBeGreaterThan(-1);
    expect(posAdj).toBeGreaterThan(-1);
    expect(posHigh).toBeLessThan(posLikely);
    expect(posLikely).toBeLessThan(posAdj);
  });
});
