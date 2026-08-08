import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember } from "../../mcp/tools/remember";
import { appendToNoteContent, refreshNoteEmbedding } from "../../mcp/tools/update_note_helpers";
import { EmbeddingClient } from "../../mcp/engine/embeddings";

// 0.44.0 - the embedding-staleness family (insights 44d445bb + 1ad2c09d).
//
// FOUR write paths mutated note content and left the embedding untouched, so
// the text was FTS-findable and semantically invisible. Measured on the live
// KB before the fix: 715 of 7083 notes provably carried content their vector
// did not cover, skewed toward insight / work_item / anti_pattern - the types
// that get maintained most, because maintenance means appends.
//
// The four:
//   1. update_note append_content          (server.ts, guarded on `content`)
//   2. update_work_item content AND append (server.ts, no embed call at all)
//   3. backfill could not repair staleness (embeddings.ts, WHERE ... IS NULL)
//   4. note() gate resolution update_existing (remember.ts, the odd-one-out
//      branch - its three siblings embed via insertNote, it did not)
//
// Tests below are split deliberately: BEHAVIOUR for what is importable, and
// WIRING (source assertions) for the two server.ts handler sites that are not.
// 0.37.0 shipped a guard inert behind thirteen green tests that all exercised
// a pure function while the wiring was broken - the wiring block is the part
// that would actually have caught it.

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

/** A client that records every refresh and writes a real embeddings row. */
function makeSpyClient() {
  const calls: Array<{ id: string; content: string }> = [];
  const client = new EmbeddingClient("http://127.0.0.1:0");
  (client as any).embedIfAvailable = async (db: Database, noteId: string, content: string) => {
    calls.push({ id: noteId, content });
    db.run(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`,
      [noteId, Buffer.from(new Float32Array([0.1, 0.2]).buffer), "stub", new Date().toISOString()]
    );
    return true;
  };
  return { client, calls };
}

/** A client whose embed always rejects - exercises the failure path. */
function makeFailingClient() {
  const removed: string[] = [];
  const client = new EmbeddingClient("http://127.0.0.1:0");
  (client as any).embedIfAvailable = async () => {
    throw new Error("sidecar down");
  };
  (client as any).removeEmbedding = (_db: Database, noteId: string) => {
    removed.push(noteId);
  };
  return { client, removed };
}

describe("0.44.0 defect 1: appendToNoteContent refreshes the embedding", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("append re-embeds the note with the FULL post-append content", async () => {
    const { client, calls } = makeSpyClient();
    const created = await handleRemember(projectDb, globalDb, {
      content: "original body",
      type: "insight",
    });
    const result = appendToNoteContent(projectDb, created.note_id!, "appended headline", client);
    await result.embedding;

    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe(created.note_id!);
    // The whole point: the vector must cover the appended text, not just the
    // original. Embedding only the delta would leave the same blind spot.
    expect(calls[0].content).toContain("original body");
    expect(calls[0].content).toContain("appended headline");
  });

  test("the embeddings row is actually newer than the append", async () => {
    const { client } = makeSpyClient();
    const created = await handleRemember(projectDb, globalDb, { content: "x", type: "insight" });
    projectDb.run("DELETE FROM embeddings WHERE note_id = ?", [created.note_id!]);

    const result = appendToNoteContent(projectDb, created.note_id!, "later fact", client);
    await result.embedding;

    const row = projectDb
      .query("SELECT e.embedded_at, n.updated_at FROM notes n JOIN embeddings e ON e.note_id = n.id WHERE n.id = ?")
      .get(created.note_id!) as { embedded_at: string; updated_at: string };
    expect(row).not.toBeNull();
    expect(row.embedded_at >= row.updated_at).toBe(true);
  });

  test("still appends when no client is supplied (graceful degradation)", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "a", type: "insight" });
    const result = appendToNoteContent(projectDb, created.note_id!, "b");
    expect(result.appended).toBe(true);
    expect(result.embedding).toBeUndefined();
    const row = projectDb.query("SELECT content FROM notes WHERE id = ?").get(created.note_id!) as any;
    expect(row.content).toContain("b");
  });

  test("a failing sidecar drops the stale vector instead of keeping a lie", async () => {
    const { client, removed } = makeFailingClient();
    const created = await handleRemember(projectDb, globalDb, { content: "a", type: "insight" });
    const result = appendToNoteContent(projectDb, created.note_id!, "b", client);
    await result.embedding;
    // Removing beats retaining: a vector that no longer matches the text is
    // worse than none, because backfill can repair a missing one.
    expect(removed).toContain(created.note_id!);
  });

  test("append still succeeds even though the embed rejected", async () => {
    const { client } = makeFailingClient();
    const created = await handleRemember(projectDb, globalDb, { content: "a", type: "insight" });
    const result = appendToNoteContent(projectDb, created.note_id!, "b", client);
    await result.embedding;
    expect(result.appended).toBe(true);
    const row = projectDb.query("SELECT content FROM notes WHERE id = ?").get(created.note_id!) as any;
    expect(row.content).toContain("b");
  });

  test("a partial duck-typed client cannot break the write", async () => {
    // Found by an EXISTING test (remember.test.ts R4 gate), not by this file.
    // Call sites pass `{ embed } as unknown as EmbeddingClient` in several
    // places, so calling embedIfAvailable on one throws SYNCHRONOUSLY - before
    // any promise exists, so .catch() never sees it and the whole note write
    // dies. A best-effort refresh must never be able to fail a content write.
    const partial = { embed: async () => [new Float32Array([1])] } as any;
    const created = await handleRemember(projectDb, globalDb, { content: "a", type: "insight" });
    const result = appendToNoteContent(projectDb, created.note_id!, "b", partial);
    expect(result.appended).toBe(true);
    const row = projectDb.query("SELECT content FROM notes WHERE id = ?").get(created.note_id!) as any;
    expect(row.content).toContain("b");
  });

  test("refreshNoteEmbedding swallows a synchronously-throwing client", async () => {
    const exploding = {
      embedIfAvailable: () => {
        throw new Error("sync boom");
      },
    } as any;
    expect(() => refreshNoteEmbedding(projectDb, "any-id", "text", exploding)).not.toThrow();
  });

  test("missing id neither appends nor embeds", () => {
    const { client, calls } = makeSpyClient();
    const result = appendToNoteContent(projectDb, "nonexistent", "x", client);
    expect(result.appended).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe("0.44.0 defect 4: the gate's update_existing resolution re-embeds its target", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("update_existing embeds the merged target", async () => {
    const { client, calls } = makeSpyClient();
    const target = await handleRemember(projectDb, globalDb, {
      content: "the original decision body",
      type: "decision",
    });
    calls.length = 0;

    const res = await handleRemember(
      projectDb,
      globalDb,
      {
        content: "the merged-in delta",
        type: "decision",
        resolution: { action: "update_existing", target_id: target.note_id! },
      } as any,
      client
    );
    // Give the fire-and-forget refresh a turn to settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(res.note_id).toBe(target.note_id!);
    // The gate fires BECAUSE of embedding similarity, then merges knowledge in.
    // If it does not re-embed, it degrades the very index that triggered it.
    expect(calls.some((c) => c.id === target.note_id!)).toBe(true);
    const merged = calls.find((c) => c.id === target.note_id!)!;
    expect(merged.content).toContain("the original decision body");
    expect(merged.content).toContain("the merged-in delta");
  });
});

describe("0.44.0 defect 3: backfill repairs STALE embeddings, not just missing ones", () => {
  test("a note whose content changed after embedded_at is re-embedded", async () => {
    const db = makeDb("project");
    const globalDb = makeDb("global");
    const created = await handleRemember(db, globalDb, { content: "body", type: "insight" });

    // Plant a stale row: present, but older than the note's content.
    db.run(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`,
      [created.note_id!, Buffer.from(new Float32Array([0.1]).buffer), "stub", "2020-01-01T00:00:00.000Z"]
    );
    db.run("UPDATE notes SET updated_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", created.note_id!]);

    const client = new EmbeddingClient("http://127.0.0.1:0");
    (client as any).embed = async (texts: string[]) => texts.map(() => new Float32Array([0.9]));

    const res = await client.backfill(db);
    // Pre-fix this returned 0: the WHERE clause only saw NULL rows, so a stale
    // vector was skipped forever and staleness was permanent.
    expect(res.embedded).toBeGreaterThan(0);
    const row = db.query("SELECT embedded_at FROM embeddings WHERE note_id = ?").get(created.note_id!) as any;
    expect(row.embedded_at > "2020-01-01T00:00:00.000Z").toBe(true);
  });

  test("a fresh note is NOT needlessly re-embedded", async () => {
    const db = makeDb("project");
    const globalDb = makeDb("global");
    const created = await handleRemember(db, globalDb, { content: "body", type: "insight" });
    db.run(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`,
      [created.note_id!, Buffer.from(new Float32Array([0.1]).buffer), "stub", "2099-01-01T00:00:00.000Z"]
    );
    const client = new EmbeddingClient("http://127.0.0.1:0");
    let embedCalls = 0;
    (client as any).embed = async (texts: string[]) => {
      embedCalls++;
      return texts.map(() => new Float32Array([0.9]));
    };
    await client.backfill(db);
    // Guards the negative direction: a repair that re-embeds everything every
    // run is a different bug (cost), and would make this suite pass vacuously.
    expect(embedCalls).toBe(0);
  });
});

describe("0.44.0 defect 2: WIRING - update_work_item refreshes on both paths", () => {
  // update_work_item's handler is an inline registerTool callback in server.ts
  // and cannot be imported. Assert the wiring at source, per the 0.43.2
  // precedent. Pre-fix the whole handler (server.ts:1803-1983) contained ZERO
  // embedIfAvailable calls - not on append, and not on a full content rewrite,
  // which is what falsified the "rewrite refreshes embeddings" workaround the
  // fleet was using.
  const SERVER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "server.ts"), "utf8");

  function updateWorkItemBody(): string {
    const start = SERVER.indexOf('"update_work_item"');
    expect(start).toBeGreaterThan(-1);
    const end = SERVER.indexOf('"breakdown"', start);
    expect(end).toBeGreaterThan(start);
    return SERVER.slice(start, end);
  }

  test("the update_work_item handler refreshes embeddings", () => {
    const body = updateWorkItemBody();
    expect(/refreshNoteEmbedding|embedIfAvailable/.test(body)).toBe(true);
  });

  test("the refresh is reachable from the full-content-rewrite path", () => {
    // The specific false promise: sessions did full rewrites of work items
    // believing it bought semantic currency (see 7c30b7e1's tag
    // `full-rewrite-for-embedding-refresh`). It never did.
    const body = updateWorkItemBody();
    const idx = body.search(/refreshNoteEmbedding|embedIfAvailable/);
    expect(idx).toBeGreaterThan(-1);
  });

  test("update_note's append path reaches a refresh too", () => {
    // Pre-fix the only refresh in the file sat behind `content !== undefined`,
    // which the append branch could never satisfy.
    expect(SERVER).toContain("refreshNoteEmbedding");
  });

  test("the content write guard and the refresh guard are the SAME predicate", () => {
    // PA proposed flipping the refresh to `content !== undefined` for
    // consistency with the update_note path. That would be a bug HERE: the
    // write is falsy-guarded, so content === "" skips the UPDATE and leaves
    // the stored description intact - re-embedding on "" would point the
    // vector at an empty body while the note still says something, which is
    // the exact staleness this release fixes. The two guards must move
    // together. This pins that, because a comment is not a control.
    const body = updateWorkItemBody();
    const writeGuard = /if \(content\) \{\s*setFragments\.push\("content = \?"\)/.test(body);
    expect(writeGuard).toBe(true);
    const refreshGuard = /if \(content\) \{\s*refreshNoteEmbedding\(/.test(body);
    expect(refreshGuard).toBe(true);
  });

  test("appendToNoteContent call sites pass an embedding client", () => {
    // The choke-point guarantee: every caller of the append helper must hand
    // it a client, or that path silently reintroduces the defect.
    const callSites = [...SERVER.matchAll(/appendToNoteContent\(([^)]*)\)/g)];
    expect(callSites.length).toBeGreaterThan(0);
    for (const m of callSites) {
      expect(m[1]).toContain("embeddingClient");
    }
  });
});
