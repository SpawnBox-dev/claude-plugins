import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { applyMigrations } from "../../mcp/db/schema";
import { findRelatedNotesHybrid } from "../../mcp/engine/linker";
import { ACTIVE_EMBED_MODEL } from "../../mcp/engine/embeddings";
import { now, generateId } from "../../mcp/utils";

// 0.49.0 - the fusion could not surface a pure-meaning match.
//
// MEASURED on the live 7148-note KB: a note that was the #2 best semantic
// match IN THE ENTIRE CORPUS did not appear in the top 6. Its journey was
// vector #2 -> RRF #11 -> #19 after the signal/confidence boost -> cut by
// candidateTopK = slice(0, limit*2).
//
// Two structural suppressors, neither wrong on its own:
//  - RRF scores a note in BOTH lists twice (up to ~0.033) and a vector-only
//    note once (max 1/61 = 0.0164), and only the ~18 FTS hits are eligible for
//    the bonus. So cosine quality cannot overcome absence from the keyword list.
//  - The boost multiplies by `signal`, which is EARNED BY BEING SURFACED - the
//    absorbing state already found in briefing ordering (ed316fcd entry R).
//
// Net: semantic-only discovery, the entire reason the embedding model exists,
// was discarded at fusion.

function makeDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  return db;
}

function unit(dim: number, i: number): Float32Array {
  const v = new Float32Array(dim);
  v[i] = 1;
  return v;
}

function addNote(db: Database, content: string, vec: Float32Array, signal = 0) {
  const id = generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, signal, created_at, updated_at)
     VALUES (?, 'insight', ?, NULL, ?, '', 'medium', 0, ?, ?, ?)`,
    [id, content, content.toLowerCase().split(/\s+/).join(","), signal, ts, ts]
  );
  db.run(
    `INSERT INTO note_chunks (note_id, chunk_index, vector, model, embedded_at) VALUES (?, 0, ?, ?, ?)`,
    [id, Buffer.from(vec.buffer), ACTIVE_EMBED_MODEL, ts]
  );
  db.run(
    `INSERT INTO embeddings (note_id, vector, model, embedded_at) VALUES (?, ?, ?, ?)`,
    [id, Buffer.from(vec.buffer), ACTIVE_EMBED_MODEL, ts]
  );
  return id;
}

describe("0.49.0: semantic reserve", () => {
  test("the best semantic match surfaces even with ZERO keyword overlap", async () => {
    const db = makeDb();
    const DIM = 8;
    // The target shares no query vocabulary at all - only meaning, expressed
    // here as vector proximity. This is the case that was being dropped.
    const target = addNote(db, "zzz completely unrelated wording", unit(DIM, 0));
    // Decoys that DO match the query lexically and carry high signal, which is
    // exactly the population that was crowding the target out.
    for (let i = 0; i < 30; i++) {
      addNote(db, `alpha beta gamma delta filler ${i}`, unit(DIM, 3), 80);
    }

    const results = await findRelatedNotesHybrid(db, "alpha beta gamma delta", 6, unit(DIM, 0), 0.7, false);
    expect(results.some((r) => r.id === target)).toBe(true);
  });

  test("it does NOT evict the top hybrid result", async () => {
    const db = makeDb();
    const DIM = 8;
    // A note both signals agree on must stay first - the reserve displaces
    // from the tail, never the head.
    //
    // Fillers are given signal 0 DELIBERATELY. An earlier version of this
    // fixture gave them 50, and the agreed note landed at #2 - not because of
    // the reserve (which only appends to the tail) but because the
    // pre-existing signal boost let a high-signal filler outrank a note that
    // won on BOTH signals. That is a real and separate finding, recorded in
    // the semantic-reserve work item; mixing it in here would have made this
    // test measure something other than its name.
    const agreed = addNote(db, "alpha beta gamma delta perfect match", unit(DIM, 0), 5);
    for (let i = 0; i < 20; i++) addNote(db, `alpha beta filler ${i}`, unit(DIM, 5), 0);

    const results = await findRelatedNotesHybrid(db, "alpha beta gamma delta", 6, unit(DIM, 0), 0.7, false);
    expect(results[0].id).toBe(agreed);
  });

  test("keyword still owns the majority of the result set", async () => {
    const db = makeDb();
    const DIM = 8;
    const semantic: string[] = [];
    for (let i = 0; i < 5; i++) semantic.push(addNote(db, `zzz unrelated ${i}`, unit(DIM, 0)));
    for (let i = 0; i < 20; i++) addNote(db, `alpha beta gamma filler ${i}`, unit(DIM, 6), 40);

    const results = await findRelatedNotesHybrid(db, "alpha beta gamma", 6, unit(DIM, 0), 0.7, false);
    const reserved = results.filter((r) => semantic.includes(r.id)).length;
    // At most 2 of 6 - the reserve is deliberately small.
    expect(reserved).toBeLessThanOrEqual(2);
  });

  test("a superseded note is never promoted by the reserve", async () => {
    const db = makeDb();
    const DIM = 8;
    const hidden = addNote(db, "zzz superseded thing", unit(DIM, 0));
    db.run(`UPDATE notes SET superseded_by = 'someone-else' WHERE id = ?`, [hidden]);
    for (let i = 0; i < 10; i++) addNote(db, `alpha beta filler ${i}`, unit(DIM, 4), 10);

    const results = await findRelatedNotesHybrid(db, "alpha beta", 6, unit(DIM, 0), 0.7, false);
    // The reserve must respect the same filters as every other path, or it
    // becomes a back door around them.
    expect(results.some((r) => r.id === hidden)).toBe(false);
  });

  test("no vector at all still returns keyword results", async () => {
    const db = makeDb();
    const DIM = 8;
    addNote(db, "alpha beta gamma", unit(DIM, 1), 0);
    const results = await findRelatedNotesHybrid(db, "alpha beta gamma", 6, undefined, 0.7, false);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("0.49.0: WIRING", () => {
  const LINKER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "engine", "linker.ts"), "utf8");

  test("the reserve is bounded and cannot swallow the result set", () => {
    expect(LINKER).toContain("SEMANTIC_RESERVED");
    expect(/SEMANTIC_RESERVED = Math\.min\(2/.test(LINKER)).toBe(true);
  });

  test("it displaces from the tail, not the head", () => {
    expect(/finalIds\.pop\(\)/.test(LINKER)).toBe(true);
  });
});

describe("0.50.0: query instruction is applied to SEARCH only", () => {
  const EMB = readFileSync(join(import.meta.dir, "..", "..", "mcp", "engine", "embeddings.ts"), "utf8");
  const RECALL = readFileSync(join(import.meta.dir, "..", "..", "mcp", "tools", "recall.ts"), "utf8");
  const CHECK = readFileSync(join(import.meta.dir, "..", "..", "mcp", "tools", "check_similar.ts"), "utf8");
  const REMEMBER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "tools", "remember.ts"), "utf8");

  test("the instruction exists and is prepended on the search path", () => {
    // BGE is trained asymmetrically: query carries an instruction, passages do
    // not. We embedded both bare, putting the query in the wrong region.
    expect(EMB).toContain("QUERY_INSTRUCTION");
    expect(/embed\(\[QUERY_INSTRUCTION \+ input\.query\]\)/.test(RECALL)).toBe(true);
  });

  test("it is NOT applied to document-to-document comparison", () => {
    // The near-duplicate gate and the relevance push compare passage to
    // passage. Prefixing one side would break the symmetry they depend on -
    // this is the half that is easy to get wrong by applying the constant
    // everywhere it compiles.
    expect(CHECK).not.toContain("QUERY_INSTRUCTION");
    expect(REMEMBER).not.toContain("QUERY_INSTRUCTION");
  });
});
