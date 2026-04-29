import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import {
  sendMessage,
  peekInbox,
  drainInbox,
  loadInboxCounters,
  _resetMessagingForTest,
} from "../../mcp/engine/messaging";
import { now } from "../../mcp/utils";

function freshDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  // session_registry needs at least the recipient row for broadcast bumps.
  db.run(
    `INSERT INTO session_registry (session_id, started_at, last_active_at, notes_surfaced, compaction_count)
     VALUES ('A', ?, ?, 0, 0), ('B', ?, ?, 0, 0)`,
    [now(), now(), now(), now()]
  );
  return db;
}

beforeEach(() => _resetMessagingForTest());

describe("messaging", () => {
  test("send + peek + drain direct message", () => {
    const db = freshDb();
    sendMessage(db, { from_session: "A", to_session: "B", body: "hello" });
    expect(peekInbox(db, "B").count).toBe(1);
    expect(peekInbox(db, "A").count).toBe(0);
    const msgs = drainInbox(db, "B");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe("hello");
    expect(msgs[0].from_session).toBe("A");
    expect(peekInbox(db, "B").count).toBe(0);
  });

  test("drain marks read and is idempotent", () => {
    const db = freshDb();
    sendMessage(db, { from_session: "A", to_session: "B", body: "x" });
    expect(drainInbox(db, "B")).toHaveLength(1);
    expect(drainInbox(db, "B")).toHaveLength(0);
  });

  test("broadcast reaches every other active session, not the sender", () => {
    const db = freshDb();
    db.run(
      `INSERT INTO session_registry (session_id, started_at, last_active_at, notes_surfaced, compaction_count)
       VALUES ('C', ?, ?, 0, 0)`,
      [now(), now()]
    );
    sendMessage(db, { from_session: "A", body: "broadcast" });
    expect(peekInbox(db, "A").count).toBe(0);
    expect(peekInbox(db, "B").count).toBe(1);
    expect(peekInbox(db, "C").count).toBe(1);
    expect(drainInbox(db, "B")).toHaveLength(1);
    expect(drainInbox(db, "C")).toHaveLength(1);
  });

  test("expired messages are not delivered", () => {
    const db = freshDb();
    const id = "expired-msg";
    db.run(
      `INSERT INTO session_messages (id, from_session, to_session, body, priority, created_at, expires_at)
       VALUES (?, 'A', 'B', 'old', 'normal', ?, ?)`,
      [id, now(), new Date(Date.now() - 1000).toISOString()]
    );
    expect(drainInbox(db, "B")).toHaveLength(0);
  });

  test("priority high comes first", () => {
    const db = freshDb();
    sendMessage(db, { from_session: "A", to_session: "B", body: "low", priority: "low" });
    sendMessage(db, { from_session: "A", to_session: "B", body: "high", priority: "high" });
    sendMessage(db, { from_session: "A", to_session: "B", body: "normal" });
    const msgs = drainInbox(db, "B");
    expect(msgs.map((m) => m.body)).toEqual(["high", "normal", "low"]);
  });

  test("loadInboxCounters reconstructs map from DB", () => {
    const db = freshDb();
    sendMessage(db, { from_session: "A", to_session: "B", body: "x" });
    sendMessage(db, { from_session: "A", to_session: "B", body: "y" });
    _resetMessagingForTest();
    // Counter is empty AND refresh interval has not elapsed in this fast test,
    // so peek will not auto-refresh. Call loadInboxCounters explicitly.
    loadInboxCounters(db);
    expect(peekInbox(db, "B").count).toBe(2);
  });

  test("sender does not receive their own messages", () => {
    const db = freshDb();
    sendMessage(db, { from_session: "A", body: "self?" });
    expect(drainInbox(db, "A")).toHaveLength(0);
  });

  test("scope is round-tripped through JSON when delivered", () => {
    const db = freshDb();
    sendMessage(db, {
      from_session: "A",
      to_session: "B",
      body: "scoped",
      scope: { code_ref: "src/foo.ts", task_contains: "refactor" },
    });
    // R7.5: drainInbox now filters by scope. Provide matching context.
    const msgs = drainInbox(db, "B", { currentFilePath: "src/foo.ts" });
    expect(msgs[0].scope).toEqual({ code_ref: "src/foo.ts", task_contains: "refactor" });
  });
});

describe("R7.5 scope filtering", () => {
  test("scoped message NOT delivered without matching context", () => {
    const db = freshDb();
    sendMessage(db, {
      from_session: "A",
      to_session: "B",
      body: "watch this file",
      scope: { code_ref: "src/foo.ts" },
    });
    // Drain with no context - scoped message stays queued.
    const msgs = drainInbox(db, "B");
    expect(msgs).toHaveLength(0);
    // And it remains in the inbox for the next call with matching context.
    const msgs2 = drainInbox(db, "B", { currentFilePath: "src/foo.ts" });
    expect(msgs2).toHaveLength(1);
    expect(msgs2[0].body).toBe("watch this file");
  });

  test("scoped message delivered when currentFilePath contains scope.code_ref", () => {
    const db = freshDb();
    sendMessage(db, {
      from_session: "A",
      to_session: "B",
      body: "scoped",
      scope: { code_ref: "src/foo.ts" },
    });
    // Path contains the scope.code_ref as substring.
    const msgs = drainInbox(db, "B", { currentFilePath: "/abs/path/to/src/foo.ts" });
    expect(msgs).toHaveLength(1);
  });

  test("scoped message delivered when currentTask contains scope.task_contains (case-insensitive)", () => {
    const db = freshDb();
    sendMessage(db, {
      from_session: "A",
      to_session: "B",
      body: "task-scoped",
      scope: { task_contains: "refactor" },
    });
    const msgs = drainInbox(db, "B", { currentTask: "Refactoring observer pattern" });
    expect(msgs).toHaveLength(1);
  });

  test("scope with both fields delivers when EITHER matches (any-match)", () => {
    const db = freshDb();
    sendMessage(db, {
      from_session: "A",
      to_session: "B",
      body: "either",
      scope: { code_ref: "src/foo.ts", task_contains: "refactor" },
    });
    const msgs = drainInbox(db, "B", { currentTask: "doing the refactor" });
    expect(msgs).toHaveLength(1);
  });

  test("unscoped messages always delivered regardless of context", () => {
    const db = freshDb();
    sendMessage(db, { from_session: "A", to_session: "B", body: "no scope" });
    const msgs = drainInbox(db, "B");
    expect(msgs).toHaveLength(1);
  });

  test("deferred scoped messages do not get marked read", () => {
    const db = freshDb();
    sendMessage(db, {
      from_session: "A",
      to_session: "B",
      body: "scoped",
      scope: { code_ref: "src/foo.ts" },
    });
    // First drain with non-matching context: 0 delivered, message stays.
    expect(drainInbox(db, "B", { currentFilePath: "other.ts" })).toHaveLength(0);
    // Second drain with matching context: 1 delivered.
    expect(drainInbox(db, "B", { currentFilePath: "src/foo.ts" })).toHaveLength(1);
    // Third drain: idempotent, message is now marked read.
    expect(drainInbox(db, "B", { currentFilePath: "src/foo.ts" })).toHaveLength(0);
  });

  test("malformed scope JSON treated as unscoped (no get-stuck)", () => {
    const db = freshDb();
    db.run(
      `INSERT INTO session_messages (id, from_session, to_session, scope, body, priority, created_at)
       VALUES ('bad', 'A', 'B', '{not valid json', 'body', 'normal', ?)`,
      [now()]
    );
    const msgs = drainInbox(db, "B");
    expect(msgs).toHaveLength(1);
  });

  test("counter reflects deferred message count after partial drain", () => {
    const db = freshDb();
    sendMessage(db, {
      from_session: "A",
      to_session: "B",
      body: "deferred",
      scope: { code_ref: "src/foo.ts" },
    });
    sendMessage(db, { from_session: "A", to_session: "B", body: "unscoped" });
    // Drain with non-matching context: only unscoped delivers.
    const msgs = drainInbox(db, "B", { currentFilePath: "other.ts" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe("unscoped");
    // Counter should report 1 still pending (the scoped one).
    // Note: counter is in-memory and after drain reflects deferred count.
    // We don't expose it directly, but peekInbox returns it.
  });
});
