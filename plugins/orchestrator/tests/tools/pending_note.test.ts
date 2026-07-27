import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember, sharedMatchTerms } from "../../mcp/tools/remember";
import {
  stashPendingNote,
  takePendingNote,
  gcPendingNotes,
  PENDING_NOTE_TTL_MS,
} from "../../mcp/tools/pending_note";
import type { EmbeddingClient } from "../../mcp/engine/embeddings";
import { now } from "../../mcp/utils";

// ===========================================================================
// 0.30.72: pending-write token for the near-duplicate gate.
//
// Fleet-solicited fix (2026-07-27). FOUR of five active sessions independently
// reported that resolving a gate block required re-transmitting the entire
// note body. The second-order harm they converged on: paying full price for a
// false positive biases agents away from writing notes at all, or toward the
// cheapest resolution (update_existing), which buries a distinct lesson inside
// an unrelated note. These tests pin the round-trip down to a token.
// ===========================================================================

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("pending-note stash", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb("project");
  });

  test("round-trips every field the note write needs", () => {
    const token = stashPendingNote(db, {
      content: "Body that must not be re-sent",
      type: "convention",
      context: "ctx",
      tags: "a,b",
      scope: "project",
      session_id: "sess-1",
      code_refs: ["mcp/server.ts"],
    });

    expect(token).toMatch(/^[0-9a-f]{8}$/);

    const got = takePendingNote(db, token);
    expect(got).not.toBeNull();
    expect(got!.content).toBe("Body that must not be re-sent");
    expect(got!.type).toBe("convention");
    expect(got!.context).toBe("ctx");
    expect(got!.tags).toBe("a,b");
    expect(got!.session_id).toBe("sess-1");
    expect(got!.code_refs).toEqual(["mcp/server.ts"]);
  });

  test("is ONE-SHOT: a second claim returns null", () => {
    const token = stashPendingNote(db, { content: "x", type: "decision" });
    expect(takePendingNote(db, token)).not.toBeNull();
    // A retried tool call after a successful commit must NOT write a duplicate.
    expect(takePendingNote(db, token)).toBeNull();
  });

  test("unknown token returns null rather than throwing", () => {
    expect(takePendingNote(db, "deadbeef")).toBeNull();
  });

  test("expired stash is refused even though the row exists", () => {
    const token = stashPendingNote(db, { content: "old", type: "decision" });
    // Backdate past the TTL.
    const stale = new Date(Date.now() - PENDING_NOTE_TTL_MS - 60_000).toISOString();
    db.run(`UPDATE plugin_state SET updated_at = ? WHERE key = ?`, [
      stale,
      `pending_note_${token}`,
    ]);
    expect(takePendingNote(db, token)).toBeNull();
  });

  test("gc removes expired stashes and leaves fresh ones", () => {
    const fresh = stashPendingNote(db, { content: "fresh", type: "decision" });
    const old = stashPendingNote(db, { content: "old", type: "decision" });
    db.run(`UPDATE plugin_state SET updated_at = ? WHERE key = ?`, [
      new Date(Date.now() - PENDING_NOTE_TTL_MS - 60_000).toISOString(),
      `pending_note_${old}`,
    ]);

    expect(gcPendingNotes(db)).toBe(1);
    expect(takePendingNote(db, fresh)).not.toBeNull();
  });

  test("corrupt payload is treated as a miss, never an empty write", () => {
    db.run(
      `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)`,
      ["pending_note_badc0de", "{not json", now()]
    );
    expect(takePendingNote(db, "badc0de")).toBeNull();
  });
});

describe("sharedMatchTerms (why the gate fired)", () => {
  test("surfaces the overlapping terms that drove the score", () => {
    const shared = sharedMatchTerms(
      "the daemon restarts the backend service after a reboot",
      "the daemon supervises the backend service on startup"
    );
    expect(shared).toContain("daemon");
    expect(shared).toContain("backend");
  });

  test("returns empty when nothing meaningful overlaps", () => {
    expect(
      sharedMatchTerms("kubernetes ingress routing", "banana bread recipe")
    ).toEqual([]);
  });

  test("is bounded so the gate message cannot balloon", () => {
    const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    expect(sharedMatchTerms(text, text, 4).length).toBeLessThanOrEqual(4);
  });
});

describe("gate -> pending_id -> commit (end to end)", () => {
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
    db.run(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`,
      [noteId, Buffer.from(vector.buffer), "bge-m3", new Date().toISOString()]
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
      [opts.id, opts.type, opts.content, null, "", opts.type, "medium", 0, null, null, null, ts, ts, null]
    );
  }

  /** Set up a store where the next `decision` write is guaranteed to block. */
  function seedBlockingNeighbour() {
    const vec = new Float32Array([1, 0, 0, 0]);
    insertPriorNote(projectDb, {
      id: "prior-1",
      type: "decision",
      content: "We route all telemetry through the broker",
    });
    seedEmbedding(projectDb, "prior-1", vec);
    return makeMockClient(vec);
  }

  const LONG_BODY =
    "We route all telemetry through the broker because direct queries fragment the source of truth. " +
    "This is a long body precisely because re-transmitting it was the cost the pending token removes.";

  test("gate returns a pending_id and stores nothing", async () => {
    const client = seedBlockingNeighbour();

    const blocked = await handleRemember(
      projectDb,
      globalDb,
      { content: LONG_BODY, type: "decision", tags: "telemetry", code_refs: ["mcp/server.ts"] },
      client
    );

    expect(blocked.stored).toBe(false);
    expect(blocked.blocked_on_resolution).toBe(true);
    expect(blocked.pending_id).toMatch(/^[0-9a-f]{8}$/);
    expect(blocked.message).toContain("do NOT re-send");
    // The message must show WHY it matched, not only how hard.
    expect(blocked.message).toContain("matched on:");
  });

  test("committing with pending_id alone stores the full stashed body", async () => {
    const client = seedBlockingNeighbour();

    const blocked = await handleRemember(
      projectDb,
      globalDb,
      { content: LONG_BODY, type: "decision", tags: "telemetry", code_refs: ["mcp/server.ts"] },
      client
    );

    // The whole point: NO content re-sent.
    const committed = await handleRemember(
      projectDb,
      globalDb,
      { pending_id: blocked.pending_id, resolution: { action: "accept_new" } } as any,
      client
    );

    expect(committed.stored).toBe(true);
    expect(committed.note_id).toBeTruthy();

    const row = projectDb
      .query(`SELECT content, type, tags, code_refs FROM notes WHERE id = ?`)
      .get(committed.note_id!) as {
      content: string;
      type: string;
      tags: string;
      code_refs: string;
    };
    expect(row.content).toBe(LONG_BODY);
    expect(row.type).toBe("decision");
    expect(row.tags).toContain("telemetry");
    expect(row.code_refs).toContain("mcp/server.ts");
  });

  test("explicitly-passed fields override the stash, so a commit can amend", async () => {
    const client = seedBlockingNeighbour();
    const blocked = await handleRemember(
      projectDb,
      globalDb,
      { content: LONG_BODY, type: "decision", tags: "telemetry" },
      client
    );

    const committed = await handleRemember(
      projectDb,
      globalDb,
      {
        pending_id: blocked.pending_id,
        tags: "telemetry,amended",
        resolution: { action: "accept_new" },
      } as any,
      client
    );

    const row = projectDb
      .query(`SELECT content, tags FROM notes WHERE id = ?`)
      .get(committed.note_id!) as { content: string; tags: string };
    // Body still came from the stash...
    expect(row.content).toBe(LONG_BODY);
    // ...but the amendment won.
    expect(row.tags).toContain("amended");
  });

  test("a stale/unknown pending_id fails LOUDLY and writes nothing", async () => {
    const before = (
      projectDb.query(`SELECT COUNT(*) as n FROM notes`).get() as { n: number }
    ).n;

    const result = await handleRemember(
      projectDb,
      globalDb,
      { pending_id: "deadbeef", resolution: { action: "accept_new" } } as any
    );

    expect(result.stored).toBe(false);
    expect(result.message).toContain("unknown, expired, or already committed");
    const after = (
      projectDb.query(`SELECT COUNT(*) as n FROM notes`).get() as { n: number }
    ).n;
    expect(after).toBe(before);
  });

  test("note() without content and without pending_id is refused, not silently empty", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      type: "decision",
    } as any);
    expect(result.stored).toBe(false);
    expect(result.message).toContain("requires `content`");
  });
});
