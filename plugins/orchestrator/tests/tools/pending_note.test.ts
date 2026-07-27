import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember, sharedMatchTerms } from "../../mcp/tools/remember";
import {
  stashPendingNote,
  takePendingNote,
  gcPendingNotes,
  findConcurrentCaptures,
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
    // The message must show the shared vocabulary as EVIDENCE - and must label
    // it as indicative, since the block is decided by embedding cosine, not by
    // these terms. Pinning the honest label so it cannot silently regress into
    // claiming causation.
    expect(blocked.message).toContain("overlapping terms (indicative, not the match basis)");
    expect(blocked.message).not.toContain("matched on:");
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

// ===========================================================================
// 0.30.78: CONCURRENT CAPTURE - the duplication class the gate cannot see.
//
// 2026-07-27: PA broadcast one behavioural rule to @all. Three sessions
// reacted within ~2 minutes. One captured it; one checked, found the existing
// note and correctly declined; the third ran check_similar, FOUND NOTHING, and
// filed a duplicate. The gate cleared it.
//
// SA-df343a05's correction is why the fix is mechanical rather than
// behavioural: they avoided the duplicate "by being slow, not by method" -
// checking ~3 minutes later, once the peer note was indexed. Sixty seconds
// earlier and they would have filed a third. So "look before you write" is not
// a defence: the window where it fails is exactly the window a broadcast
// creates, and everyone did look.
//
// Hence a KEYWORD check against recent writes - the notes row is inserted
// synchronously, so a peer's capture from 90 seconds ago is visible precisely
// when its embedding is not.
// ===========================================================================
describe("concurrent capture detection", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb("project");
  });

  function insert(opts: {
    id: string;
    keywords: string;
    session: string | null;
    agoMs?: number;
  }) {
    const ts = new Date(Date.now() - (opts.agoMs ?? 1000)).toISOString();
    db.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at, source_session)
       VALUES (?, 'convention', ?, NULL, ?, '', 'medium', 0, ?, ?, ?)`,
      [opts.id, `content for ${opts.id}`, opts.keywords, ts, ts, opts.session]
    );
  }

  test("finds a PEER's near-simultaneous capture of the same knowledge", () => {
    insert({ id: "peer-note", keywords: "browser,tab,navigate,rule", session: "sess-peer" });

    const hits = findConcurrentCaptures(db, {
      noteId: "mine",
      keywords: ["browser", "tab", "navigate", "rule"],
      sessionId: "sess-mine",
    });

    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe("peer-note");
    expect(hits[0].session).toBe("sess-peer");
  });

  test("ignores the session's OWN recent notes", () => {
    // A session duplicating itself is usually intentional (a split note).
    insert({ id: "my-other", keywords: "browser,tab,navigate,rule", session: "sess-mine" });
    expect(
      findConcurrentCaptures(db, {
        noteId: "mine",
        keywords: ["browser", "tab", "navigate", "rule"],
        sessionId: "sess-mine",
      })
    ).toEqual([]);
  });

  test("ignores notes outside the recency window", () => {
    insert({
      id: "old-peer",
      keywords: "browser,tab,navigate,rule",
      session: "sess-peer",
      agoMs: 60 * 60 * 1000,
    });
    expect(
      findConcurrentCaptures(db, {
        noteId: "mine",
        keywords: ["browser", "tab", "navigate", "rule"],
        sessionId: "sess-mine",
      })
    ).toEqual([]);
  });

  test("requires real overlap, not one incidental shared word", () => {
    insert({ id: "unrelated", keywords: "browser,cache,eviction", session: "sess-peer" });
    expect(
      findConcurrentCaptures(db, {
        noteId: "mine",
        keywords: ["browser", "tab", "navigate", "rule"],
        sessionId: "sess-mine",
      })
    ).toEqual([]);
  });

  test("does NOT depend on embeddings - that is the entire point", () => {
    // No embeddings row exists for the peer note. check_similar would return
    // nothing here; this must still find it.
    insert({ id: "unembedded", keywords: "browser,tab,navigate,rule", session: "sess-peer" });
    const embeddings = db
      .query(`SELECT COUNT(*) AS c FROM embeddings`)
      .get() as { c: number };
    expect(embeddings.c).toBe(0);

    expect(
      findConcurrentCaptures(db, {
        noteId: "mine",
        keywords: ["browser", "tab", "navigate", "rule"],
        sessionId: "sess-mine",
      }).length
    ).toBe(1);
  });
});
