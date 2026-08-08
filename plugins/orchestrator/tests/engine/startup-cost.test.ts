import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { applyMigrations } from "../../mcp/db/schema";
import { EmbeddingClient } from "../../mcp/engine/embeddings";
import { generateId, now } from "../../mcp/utils";

// 0.45.1 - two defects that together brought a user's machine to a halt twice
// in one afternoon. Both are about UNBOUNDED WORK DONE WITHOUT BEING ASKED.
//
// 1. backfill() runs automatically on EVERY MCP startup. 0.44.0 widened its
//    predicate to include STALE rows (to enable backlog repair) and thereby
//    converted a startup no-op into a full-backlog job - 1350 notes here -
//    fired by every session on every start, each note seconds of CPU-bound
//    ONNX inference. 0.44.1 raised the timeout and shrank the batch, which
//    made it grind successfully for hours instead of failing fast.
// 2. The sidecar reuse port file lived under the VERSION-SPECIFIC plugin
//    cache dir, so every release started a fresh sidecar generation while old
//    ones were deliberately never killed. Eleven port files accumulated.

function makeDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  return db;
}

function seedStaleNote(db: Database) {
  const id = generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
     VALUES (?, 'insight', 'body', NULL, '', '', 'medium', 0, ?, ?)`,
    [id, ts, ts]
  );
  db.run(
    `INSERT INTO embeddings (note_id, vector, model, embedded_at) VALUES (?, ?, ?, ?)`,
    [id, Buffer.from(new Float32Array([0.1]).buffer), "stub", "2020-01-01T00:00:00.000Z"]
  );
  return id;
}

describe("0.45.1: the automatic startup backfill must not sweep the stale backlog", () => {
  test("DEFAULT skips stale rows entirely - no embed calls, no work", async () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) seedStaleNote(db);

    const client = new EmbeddingClient("http://127.0.0.1:1");
    let embedCalls = 0;
    (client as any).embed = async (texts: string[]) => {
      embedCalls++;
      return texts.map(() => new Float32Array([0.9]));
    };

    const res = await client.backfill(db);
    // THE assertion. Pre-fix this attempted all 5 and would attempt 1350 on
    // the real KB, on every session start, forever.
    expect(embedCalls).toBe(0);
    expect(res.attempted).toBe(0);
    expect(res.embedded).toBe(0);
  });

  test("MISSING embeddings are still filled by default (startup keeps working)", async () => {
    const db = makeDb();
    const ts = now();
    db.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
       VALUES ('n1', 'insight', 'body', NULL, '', '', 'medium', 0, ?, ?)`,
      [ts, ts]
    );
    const client = new EmbeddingClient("http://127.0.0.1:1");
    (client as any).embed = async (texts: string[]) => texts.map(() => new Float32Array([0.9]));

    const res = await client.backfill(db);
    expect(res.embedded).toBe(1);
  });

  test("the stale sweep is still available when EXPLICITLY requested", async () => {
    const db = makeDb();
    for (let i = 0; i < 3; i++) seedStaleNote(db);
    const client = new EmbeddingClient("http://127.0.0.1:1");
    (client as any).embed = async (texts: string[]) => texts.map(() => new Float32Array([0.9]));

    const res = await client.backfill(db, 8, { includeStale: true });
    expect(res.embedded).toBe(3);
  });
});

describe("0.45.1: WIRING - startup call sites must not opt into the stale sweep", () => {
  const SERVER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "server.ts"), "utf8");

  test("no automatic backfill call passes includeStale", () => {
    // The fix is worthless if a startup path opts back in. Repair must be
    // driven deliberately, never by a process starting up.
    for (const m of SERVER.matchAll(/\.backfill\(([^)]*)\)/g)) {
      expect(m[1]).not.toContain("includeStale");
    }
  });

  test("backfill is still called at startup (we did not fix this by deleting it)", () => {
    expect(SERVER).toContain(".backfill(getProjectDb())");
  });
});

describe("0.45.1: WIRING - the sidecar port file is version-independent", () => {
  const SERVER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "server.ts"), "utf8");

  test("the port file does NOT live under pluginRoot", () => {
    // pluginRoot is the version-specific cache dir, so a port file there
    // scopes sidecar reuse per release and spawns a new ~1.5GB generation on
    // every upgrade.
    expect(/portFile\s*=\s*resolve\(\s*pluginRoot/.test(SERVER)).toBe(false);
  });

  test("it resolves under a stable per-user directory", () => {
    expect(/sidecarStateDir\s*=\s*join\(\s*homedir\(\)/.test(SERVER)).toBe(true);
    expect(/portFile\s*=\s*resolve\(\s*sidecarStateDir/.test(SERVER)).toBe(true);
  });
});
