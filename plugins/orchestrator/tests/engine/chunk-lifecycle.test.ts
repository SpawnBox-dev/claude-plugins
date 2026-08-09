import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { applyMigrations } from "../../mcp/db/schema";
import { EmbeddingClient, ACTIVE_EMBED_MODEL } from "../../mcp/engine/embeddings";
import { handleRemember } from "../../mcp/tools/remember";
import { appendToNoteContent, refreshNoteEmbedding } from "../../mcp/tools/update_note_helpers";

// 0.47.2 - does passage indexing survive the FULL note lifecycle?
//
// Asked by the user, and the answer was NO for the most important case.
// handleRemember wrote the embeddings row by hand instead of calling
// embedIfAvailable, so it was a second independent writer of the same table
// and had drifted: no note_chunks row at all, and a hardcoded "bge-m3" tag
// that 0.47.0's `WHERE model = ACTIVE_EMBED_MODEL` filter then excluded.
// Every note CREATED after the model switch was invisible to vector search,
// keyword-only, with no error anywhere.
//
// These tests pin every CRUD verb, because a chunk index that silently stops
// tracking its notes is worse than none - it looks like it is working.

function makeDb(type: "project" | "global" = "project"): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  applyMigrations(db, type);
  return db;
}

function stubClient() {
  const c = new EmbeddingClient("http://127.0.0.1:1");
  (c as any).embed = async (texts: string[]) =>
    texts.map((t) => {
      const v = new Float32Array(8);
      for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) % 7;
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / n) as Float32Array;
    });
  return c;
}

const chunkCount = (db: Database, id: string) =>
  (db.query(`SELECT COUNT(*) c FROM note_chunks WHERE note_id = ?`).get(id) as any).c;

describe("0.47.2: CREATE - a brand new note is immediately searchable by passage", () => {
  test("note() writes chunks, not just a note-level vector", async () => {
    const db = makeDb();
    const g = makeDb("global");
    const res = await handleRemember(
      db, g,
      { content: "a decision about docker networking on windows", type: "decision" },
      stubClient()
    );
    expect(res.note_id).toBeTruthy();
    expect(chunkCount(db, res.note_id!)).toBeGreaterThan(0);
  });

  test("and tags them with the ACTIVE model, not a literal", async () => {
    // The regression: a hardcoded "bge-m3" made every new note invisible to a
    // search that filters on the active model.
    const db = makeDb();
    const g = makeDb("global");
    const res = await handleRemember(
      db, g,
      { content: "another note", type: "insight" },
      stubClient()
    );
    const row = db.query(`SELECT model FROM embeddings WHERE note_id = ?`).get(res.note_id!) as any;
    expect(row.model).toBe(ACTIVE_EMBED_MODEL);
    const crow = db.query(`SELECT model FROM note_chunks WHERE note_id = ? LIMIT 1`).get(res.note_id!) as any;
    expect(crow.model).toBe(ACTIVE_EMBED_MODEL);
  });

  test("a long new note is split into several passages on creation", async () => {
    const db = makeDb();
    const g = makeDb("global");
    const res = await handleRemember(
      db, g,
      { content: "a long architectural finding. ".repeat(300), type: "architecture" },
      stubClient()
    );
    expect(chunkCount(db, res.note_id!)).toBeGreaterThan(3);
  });
});

describe("0.47.2: UPDATE - edits keep the passage index current", () => {
  test("a full content rewrite re-chunks the note", async () => {
    const db = makeDb();
    const g = makeDb("global");
    const c = stubClient();
    const res = await handleRemember(db, g, { content: "short", type: "insight" }, c);
    expect(chunkCount(db, res.note_id!)).toBe(1);

    const grown = "now a much longer body. ".repeat(400);
    db.run(`UPDATE notes SET content = ? WHERE id = ?`, [grown, res.note_id!]);
    await refreshNoteEmbedding(db, res.note_id!, grown, c);
    expect(chunkCount(db, res.note_id!)).toBeGreaterThan(3);
  });

  test("an APPEND re-chunks against the full post-append body", async () => {
    const db = makeDb();
    const g = makeDb("global");
    const c = stubClient();
    const res = await handleRemember(db, g, { content: "original", type: "insight" }, c);

    const r = appendToNoteContent(db, res.note_id!, "appended detail. ".repeat(300), c);
    await r.embedding;
    expect(chunkCount(db, res.note_id!)).toBeGreaterThan(3);
  });

  test("shrinking a note DROPS the passages it no longer contains", async () => {
    // Otherwise deleted text keeps matching queries forever.
    const db = makeDb();
    const g = makeDb("global");
    const c = stubClient();
    const res = await handleRemember(db, g, { content: "big body. ".repeat(500), type: "insight" }, c);
    expect(chunkCount(db, res.note_id!)).toBeGreaterThan(3);

    await refreshNoteEmbedding(db, res.note_id!, "tiny now", c);
    expect(chunkCount(db, res.note_id!)).toBe(1);
  });
});

describe("0.47.2: DELETE - chunks do not outlive their note", () => {
  test("deleting a note cascades its passages away", async () => {
    const db = makeDb();
    const g = makeDb("global");
    const res = await handleRemember(db, g, { content: "doomed note. ".repeat(200), type: "insight" }, stubClient());
    expect(chunkCount(db, res.note_id!)).toBeGreaterThan(0);

    db.run(`DELETE FROM notes WHERE id = ?`, [res.note_id!]);
    expect(chunkCount(db, res.note_id!)).toBe(0);
  });

  test("foreign keys are enforced on real connections, or the cascade is a lie", () => {
    // SQLite ignores ON DELETE CASCADE unless this pragma is set per-connection.
    const CONN = readFileSync(join(import.meta.dir, "..", "..", "mcp", "db", "connection.ts"), "utf8");
    expect(CONN).toContain("PRAGMA foreign_keys = ON");
  });
});

describe("0.47.2: ONE writer for embeddings", () => {
  test("only embeddings.ts writes the embeddings table", () => {
    // Two independent writers is how the CREATE path drifted into writing no
    // chunks and the wrong model tag.
    const REMEMBER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "tools", "remember.ts"), "utf8");
    expect(REMEMBER).not.toContain("INSERT OR REPLACE INTO embeddings");
    expect(REMEMBER).toContain("embedIfAvailable");
  });

  test("no source file hardcodes a model name into a row", () => {
    for (const f of [
      ["mcp", "tools", "remember.ts"],
      ["mcp", "engine", "embeddings.ts"],
      ["mcp", "engine", "linker.ts"],
    ]) {
      const src = readFileSync(join(import.meta.dir, "..", "..", ...f), "utf8");
      expect(src).not.toContain('"bge-m3", ');
    }
  });
});
