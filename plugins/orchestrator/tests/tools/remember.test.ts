import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember } from "../../mcp/tools/remember";
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

// ===========================================================================
// R3.5b: similarity alert reframe
//
// Previously the alert showed ONLY the top-1 embedding match with authority
// framing ("A similar X already exists") and no action verbs. R3.5b shifts to
// attribution framing ("Possibly related existing notes"), shows up to top-3
// candidates, and attaches inline [update_note | supersede_note] maintenance
// handles to each candidate so the agent can curate instead of add a parallel
// duplicate.
//
// Testing the full alert path requires seeding embeddings. We inject a
// deterministic mock EmbeddingClient that returns fixed vectors, then
// pre-seed existing notes' embeddings directly into the embeddings table so
// the cosine-similarity path in handleCheckSimilar has rows to score against.
// ===========================================================================
describe("R3.5b: similarity alert reframe", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  /**
   * Deterministic embedding client: returns a specific Float32Array for the
   * new note's content, and lets us seed matching-ish vectors for existing
   * notes via seedEmbedding().
   */
  function makeMockClient(vector: Float32Array): EmbeddingClient {
    return {
      // Only embed() is touched by the alert path.
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

  function insertNoteForAlert(
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

  test("alert uses attribution framing, not authority framing", async () => {
    // Seed a prior decision whose vector matches the query vector exactly
    // (cosine similarity = 1.0 >= 0.75 threshold).
    // Use domain-neutral words to avoid the keyword-dedup path so we exercise
    // the embedding-similarity alert in isolation.
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertNoteForAlert(projectDb, {
      id: "prior-dec-1",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "prior-dec-1", queryVec);

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

    // New framing strings must be present.
    expect(result.message).toContain("Possibly related existing notes");
    expect(result.message).toContain("review before adding new");

    // Old authority framing must be gone.
    expect(result.message).not.toContain("RELATED PRIOR KNOWLEDGE");
    expect(result.message).not.toContain("A similar");
    expect(result.message).not.toContain("already exists");
    expect(result.message).not.toContain("Review for consistency");
  });

  test("each candidate includes update_note + supersede_note handles", async () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    insertNoteForAlert(projectDb, {
      id: "prior-dec-1",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    seedEmbedding(projectDb, "prior-dec-1", queryVec);

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
    expect(result.message).toContain('update_note({id:"prior-dec-1"})');
    expect(result.message).toContain('supersede_note({old_id:"prior-dec-1"})');
  });

  test("shows up to top-3 candidates above threshold", async () => {
    // Seed 4 prior decisions. The first three get vectors matching query
    // (similarity 1.0); the fourth gets an orthogonal vector (similarity 0).
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const orthoVec = new Float32Array([0, 1, 0, 0]);

    insertNoteForAlert(projectDb, {
      id: "match-a",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    insertNoteForAlert(projectDb, {
      id: "match-b",
      type: "decision",
      content: "beta zeta nu xi",
    });
    insertNoteForAlert(projectDb, {
      id: "match-c",
      type: "decision",
      content: "gamma eta phi chi",
    });
    insertNoteForAlert(projectDb, {
      id: "nonmatch-d",
      type: "decision",
      content: "pi rho tau upsilon",
    });

    seedEmbedding(projectDb, "match-a", queryVec);
    seedEmbedding(projectDb, "match-b", queryVec);
    seedEmbedding(projectDb, "match-c", queryVec);
    seedEmbedding(projectDb, "nonmatch-d", orthoVec);

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
    // All three matches must appear.
    expect(result.message).toContain("match-a");
    expect(result.message).toContain("match-b");
    expect(result.message).toContain("match-c");
    // Non-matching vector must NOT appear.
    expect(result.message).not.toContain("nonmatch-d");
  });

  test("shows just 1 candidate if only 1 is above threshold", async () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const orthoVec = new Float32Array([0, 1, 0, 0]);

    insertNoteForAlert(projectDb, {
      id: "match-only",
      type: "decision",
      content: "alpha epsilon theta iota",
    });
    insertNoteForAlert(projectDb, {
      id: "nonmatch-1",
      type: "decision",
      content: "pi rho tau upsilon",
    });

    seedEmbedding(projectDb, "match-only", queryVec);
    seedEmbedding(projectDb, "nonmatch-1", orthoVec);

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
    expect(result.message).toContain("match-only");
    expect(result.message).not.toContain("nonmatch-1");
    // Only one maintenance-handle block for the single candidate.
    const handleMatches = result.message.match(/update_note\(\{id:/g) ?? [];
    expect(handleMatches.length).toBe(1);
  });

  test("no alert when no embedding client is provided", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      content: "omega kappa sigma lambda mu",
      type: "decision",
    });

    expect(result.stored).toBe(true);
    expect(result.message).not.toContain("Possibly related existing notes");
    expect(result.message).not.toContain("RELATED PRIOR KNOWLEDGE");
  });
});
