# R6 — Cross-Session Inter-Agent Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-session inter-agent messaging to the orchestrator plugin (broadcast + targeted + scoped) plus active-task awareness, delivered via the densest possible hook surface (`PostToolUse`, `UserPromptSubmit`, `PreToolUse`, `Stop`, etc.) using Claude Code's `type: "mcp_tool"` hook mechanism. Migrate 7 of 8 existing bash hooks to `mcp_tool` in the same shipment so all hook logic lives in TypeScript with shared DB access. The fast path (no messages, no sibling activity) returns empty `additionalContext` so it's near-zero token cost on idle turns.

**Architecture:**
- **One new table** `session_messages` + `session_message_reads` (handles both direct and broadcast). New migration `19`.
- **Single MCP dispatch tool** `_hook_event` invoked from every migrated hook with `event_name` + payload. Keeps the orchestrator's tool surface from sprawling and centralizes hook logic.
- **In-memory inbox counters** (`Map<sessionId, number>`) so the fast path is O(1) — `_hook_event` only touches DB when counter > 0 or sibling activity changed.
- **Two new agent-callable tools** `send_message` and `update_session_task` (writes only).
- **Hook surface** broadens to `PostToolUse` matcher `.*` for densest realtime delivery, plus the existing entry/exit points.
- **`session-start` stays bash** (cold-start race protection — MCP server may not be connected yet on first session boot).

**Tech Stack:** Bun, `@modelcontextprotocol/sdk`, `bun:sqlite`, zod, existing orchestrator engine modules.

**Token-light fast-path contract:** every `_hook_event` invocation returns `{}` (no `additionalContext`, no `decision`) when there are no messages AND no fresh sibling activity since this session's last delivery. Empty JSON output costs zero tokens to the model.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `mcp/db/schema.ts` | Modify | Add migration 19 (`session_messages`, `session_message_reads`, indexes) |
| `mcp/engine/messaging.ts` | Create | `sendMessage`, `peekInbox`, `drainInbox`, in-memory `inboxCounters` map, `siblingActivity` helper |
| `mcp/engine/session_tracker.ts` | Modify | Already has `updateCurrentTask` — add `getActiveSiblings(sessionId)` returning `[{session_id, current_task, last_active_at}]` for hook injection |
| `mcp/tools/messaging.ts` | Create | `handleSendMessage`, `handleReadMessages`, `handleUpdateSessionTask` |
| `mcp/tools/hook_event.ts` | Create | `handleHookEvent({event, session_id, payload})` — single dispatcher for all migrated hooks |
| `mcp/server.ts` | Modify | Register new tools (`send_message`, `read_messages`, `update_session_task`, `_hook_event`); call `loadInboxCounters` on boot |
| `hooks/hooks.json` | Modify | Switch 7 hooks to `type: "mcp_tool"`; broaden `PostToolUse` matcher to `.*` |
| `hooks/user-prompt-submit` | Delete | Logic moves into `_hook_event` dispatcher |
| `hooks/pre-tool-use` | Delete | Logic moves into `_hook_event` dispatcher |
| `hooks/post-tool-use` | Delete | Logic moves into `_hook_event` dispatcher |
| `hooks/post-tool-use-failure` | Delete | Logic moves into `_hook_event` dispatcher |
| `hooks/pre-compact` | Delete | Logic moves into `_hook_event` dispatcher |
| `hooks/stop` | Delete | Logic moves into `_hook_event` dispatcher |
| `hooks/subagent-stop` | Delete | Logic moves into `_hook_event` dispatcher |
| `hooks/_lib.sh` | Delete | No longer used after migration |
| `hooks/run-hook.cmd` | Delete | Bash wrapper not needed for `mcp_tool` hooks |
| `hooks/session-start` | Keep | Cold-start safety; rewritten lighter — drops state-dir cleanup (now done at MCP boot) |
| `tests/engine/messaging.test.ts` | Create | Engine unit tests |
| `tests/tools/hook_event.test.ts` | Create | Dispatcher tests per event |
| `tests/integration/cross_session_messaging.test.ts` | Create | Two-session round-trip integration |
| `docs/DECISIONS.md` | Modify | Prepend R6 decision entry with rejected alternatives |
| `docs/ARCHITECTURE.md` | Modify | Add messaging engine + dispatcher to component listings; update `Hook flow` table |
| `.claude-plugin/plugin.json` | Modify | Bump version to `0.26.0` |

---

## Phase 1 — Schema & Engine Foundations

### Task 1: Add migration 19 — `session_messages` and `session_message_reads`

**Files:**
- Modify: `mcp/db/schema.ts` (after migration 18, around line 305)

- [ ] **Step 1:** Append the new migration to the `MIGRATIONS` array.

```typescript
  {
    version: 19,
    name: "add_session_messages",
    sql: `SELECT 1;`,
    customApply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_messages (
          id TEXT PRIMARY KEY,
          from_session TEXT NOT NULL,
          to_session TEXT,
          scope TEXT,
          body TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'normal',
          created_at TEXT NOT NULL,
          expires_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_msgs_to ON session_messages(to_session, created_at);
        CREATE INDEX IF NOT EXISTS idx_msgs_from ON session_messages(from_session, created_at);
        CREATE INDEX IF NOT EXISTS idx_msgs_broadcast ON session_messages(created_at) WHERE to_session IS NULL;

        CREATE TABLE IF NOT EXISTS session_message_reads (
          msg_id TEXT NOT NULL REFERENCES session_messages(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          read_at TEXT NOT NULL,
          PRIMARY KEY (msg_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_msg_reads_session ON session_message_reads(session_id);
      `);
    },
  },
```

- [ ] **Step 2:** Commit.

```bash
git add mcp/db/schema.ts
git commit -m "feat(orchestrator): R6 migration 19 - session_messages + session_message_reads"
```

### Task 2: Create `mcp/engine/messaging.ts` with in-memory counter fast path

**Files:**
- Create: `mcp/engine/messaging.ts`

- [ ] **Step 1:** Write the engine module.

```typescript
import type { Database } from "bun:sqlite";
import { generateId, now } from "../utils";

export type MessagePriority = "low" | "normal" | "high";

export interface MessageScope {
  /** Match when target session has touched this exact code path recently. */
  code_ref?: string;
  /** Match when target session's current_task contains this substring. */
  task_contains?: string;
}

export interface SessionMessage {
  id: string;
  from_session: string;
  to_session: string | null;
  scope: MessageScope | null;
  body: string;
  priority: MessagePriority;
  created_at: string;
  expires_at: string | null;
}

export interface SendMessageInput {
  from_session: string;
  to_session?: string;
  scope?: MessageScope;
  body: string;
  priority?: MessagePriority;
  ttl_seconds?: number;
}

/**
 * Per-process in-memory unread count per recipient session id.
 * Drives the O(1) fast path for `peekInbox` so the hook can return
 * an empty response without touching the DB when the inbox is empty.
 *
 * Populated at MCP server boot (loadInboxCounters) and maintained
 * incrementally by sendMessage / drainInbox.
 *
 * Note: this is per-process. A sibling MCP server's writes go to
 * the DB; we won't see the counter bump until the next refresh.
 * The slow path (drainInbox) always trusts the DB, so missed
 * counter bumps cause delayed delivery, not lost messages.
 */
const inboxCounters = new Map<string, number>();
let lastCounterRefreshAt = 0;
const COUNTER_REFRESH_INTERVAL_MS = 30_000;

export function loadInboxCounters(db: Database): void {
  const rows = db
    .query(
      `SELECT recipient, COUNT(*) AS cnt FROM (
         SELECT m.id, COALESCE(m.to_session, sr.session_id) AS recipient
         FROM session_messages m
         LEFT JOIN session_registry sr ON m.to_session IS NULL
         WHERE (m.expires_at IS NULL OR m.expires_at > ?)
           AND NOT EXISTS (
             SELECT 1 FROM session_message_reads r
             WHERE r.msg_id = m.id AND r.session_id = COALESCE(m.to_session, sr.session_id)
           )
       )
       WHERE recipient IS NOT NULL
       GROUP BY recipient`,
      [now()]
    )
    .all() as Array<{ recipient: string; cnt: number }>;

  inboxCounters.clear();
  for (const r of rows) inboxCounters.set(r.recipient, r.cnt);
  lastCounterRefreshAt = Date.now();
}

function maybeRefreshCounters(db: Database): void {
  if (Date.now() - lastCounterRefreshAt > COUNTER_REFRESH_INTERVAL_MS) {
    loadInboxCounters(db);
  }
}

export function sendMessage(db: Database, input: SendMessageInput): SessionMessage {
  const id = generateId();
  const created_at = now();
  const expires_at = input.ttl_seconds
    ? new Date(Date.now() + input.ttl_seconds * 1000).toISOString()
    : null;
  const scope = input.scope ? JSON.stringify(input.scope) : null;
  const priority = input.priority ?? "normal";

  db.run(
    `INSERT INTO session_messages
     (id, from_session, to_session, scope, body, priority, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.from_session, input.to_session ?? null, scope, input.body, priority, created_at, expires_at]
  );

  // Increment in-memory counters for affected recipients.
  if (input.to_session) {
    inboxCounters.set(input.to_session, (inboxCounters.get(input.to_session) ?? 0) + 1);
  } else {
    // Broadcast: bump every active sibling that hasn't already read it
    // (vacuously true for a fresh insert) and isn't the sender.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const siblings = db
      .query(
        `SELECT session_id FROM session_registry
         WHERE session_id != ? AND last_active_at > ?`
      )
      .all(input.from_session, twentyFourHoursAgo) as Array<{ session_id: string }>;
    for (const s of siblings) {
      inboxCounters.set(s.session_id, (inboxCounters.get(s.session_id) ?? 0) + 1);
    }
  }

  return {
    id,
    from_session: input.from_session,
    to_session: input.to_session ?? null,
    scope: input.scope ?? null,
    body: input.body,
    priority,
    created_at,
    expires_at,
  };
}

export interface PeekResult {
  count: number;
}

/**
 * O(1) check for pending messages. Falls back to DB query at most
 * once per COUNTER_REFRESH_INTERVAL_MS to recover from sibling-process
 * writes the in-memory counter missed.
 */
export function peekInbox(db: Database, sessionId: string): PeekResult {
  maybeRefreshCounters(db);
  return { count: inboxCounters.get(sessionId) ?? 0 };
}

export function drainInbox(db: Database, sessionId: string): SessionMessage[] {
  const ts = now();
  const rows = db
    .query(
      `SELECT id, from_session, to_session, scope, body, priority, created_at, expires_at
       FROM session_messages m
       WHERE (m.to_session = ? OR m.to_session IS NULL)
         AND m.from_session != ?
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND NOT EXISTS (
           SELECT 1 FROM session_message_reads r
           WHERE r.msg_id = m.id AND r.session_id = ?
         )
       ORDER BY
         CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         created_at`,
      [sessionId, sessionId, ts, sessionId]
    )
    .all() as Array<{
      id: string;
      from_session: string;
      to_session: string | null;
      scope: string | null;
      body: string;
      priority: string;
      created_at: string;
      expires_at: string | null;
    }>;

  if (rows.length === 0) {
    inboxCounters.set(sessionId, 0);
    return [];
  }

  const insertRead = db.prepare(
    `INSERT OR IGNORE INTO session_message_reads (msg_id, session_id, read_at) VALUES (?, ?, ?)`
  );
  db.run("BEGIN");
  try {
    for (const row of rows) insertRead.run(row.id, sessionId, ts);
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }

  inboxCounters.set(sessionId, 0);

  return rows.map((r) => ({
    id: r.id,
    from_session: r.from_session,
    to_session: r.to_session,
    scope: r.scope ? (JSON.parse(r.scope) as MessageScope) : null,
    body: r.body,
    priority: r.priority as MessagePriority,
    created_at: r.created_at,
    expires_at: r.expires_at,
  }));
}

/** Test-only: reset module state between tests. */
export function _resetMessagingForTest(): void {
  inboxCounters.clear();
  lastCounterRefreshAt = 0;
}
```

- [ ] **Step 2:** Commit.

```bash
git add mcp/engine/messaging.ts
git commit -m "feat(orchestrator): R6 messaging engine with in-memory counter fast path"
```

### Task 3: Add `getActiveSiblings` to `session_tracker.ts`

**Files:**
- Modify: `mcp/engine/session_tracker.ts` (append to class)

- [ ] **Step 1:** Add the new method on `SessionTracker`.

```typescript
  /**
   * Returns sibling sessions active within the last 24 hours, with their
   * current_task. Used by the hook surface to inject one-line activity
   * awareness when present. Capped at 5 to keep additionalContext tight.
   */
  getActiveSiblings(sessionId: string): Array<{
    session_id: string;
    current_task: string | null;
    last_active_at: string;
  }> {
    const twentyFourHoursAgo = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    ).toISOString();
    return this.db
      .query(
        `SELECT session_id, current_task, last_active_at FROM session_registry
         WHERE session_id != ? AND last_active_at > ?
         ORDER BY last_active_at DESC
         LIMIT 5`
      )
      .all(sessionId, twentyFourHoursAgo) as Array<{
        session_id: string;
        current_task: string | null;
        last_active_at: string;
      }>;
  }
```

- [ ] **Step 2:** Commit.

```bash
git add mcp/engine/session_tracker.ts
git commit -m "feat(orchestrator): R6 getActiveSiblings for hook activity injection"
```

### Task 4: Phase 1 verification

- [ ] **Step 1:** Run `bun test tests/engine/` (no new tests yet — verifies existing tests still pass after the migration).

Expected: all green. Migration 19 applies cleanly on a fresh DB.

- [ ] **Step 2:** If any failure, fix before moving on. Otherwise proceed.

---

## Phase 2 — Engine Tests

### Task 5: Write `tests/engine/messaging.test.ts`

**Files:**
- Create: `tests/engine/messaging.test.ts`

- [ ] **Step 1:** Write the test file.

```typescript
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
    expect(peekInbox(db, "B").count).toBe(0); // counter reset, refresh hasn't fired
    loadInboxCounters(db);
    expect(peekInbox(db, "B").count).toBe(2);
  });

  test("sender does not receive their own messages", () => {
    const db = freshDb();
    sendMessage(db, { from_session: "A", body: "self?" });
    expect(drainInbox(db, "A")).toHaveLength(0);
  });
});
```

- [ ] **Step 2:** Run tests: `bun test tests/engine/messaging.test.ts`. All 7 should pass.

- [ ] **Step 3:** Commit.

```bash
git add tests/engine/messaging.test.ts
git commit -m "test(orchestrator): R6 messaging engine unit tests"
```

---

## Phase 3 — MCP Tools (agent-callable: send, read, update_task)

### Task 6: Create `mcp/tools/messaging.ts`

**Files:**
- Create: `mcp/tools/messaging.ts`

- [ ] **Step 1:** Write the handler file.

```typescript
import type { Database } from "bun:sqlite";
import {
  sendMessage as engineSend,
  drainInbox as engineDrain,
  type SendMessageInput,
  type MessagePriority,
} from "../engine/messaging";
import type { SessionTracker } from "../engine/session_tracker";

export interface SendMessageArgs {
  from_session: string;
  to_session?: string;
  body: string;
  scope_code_ref?: string;
  scope_task_contains?: string;
  priority?: MessagePriority;
  ttl_seconds?: number;
}

export function handleSendMessage(db: Database, args: SendMessageArgs): string {
  const scope =
    args.scope_code_ref || args.scope_task_contains
      ? {
          code_ref: args.scope_code_ref,
          task_contains: args.scope_task_contains,
        }
      : undefined;

  const input: SendMessageInput = {
    from_session: args.from_session,
    to_session: args.to_session,
    body: args.body,
    scope,
    priority: args.priority,
    ttl_seconds: args.ttl_seconds,
  };
  const msg = engineSend(db, input);

  const target = msg.to_session ?? "broadcast";
  return `Message ${msg.id.slice(0, 8)} sent (-> ${target}, priority: ${msg.priority}).`;
}

export interface ReadMessagesArgs {
  session_id: string;
}

export function handleReadMessages(db: Database, args: ReadMessagesArgs): string {
  const msgs = engineDrain(db, args.session_id);
  if (msgs.length === 0) return "Inbox empty.";

  const lines = msgs.map((m) => {
    const target = m.to_session ? `direct` : `broadcast`;
    const age = ageOf(m.created_at);
    const scopeStr = m.scope
      ? ` (scope: ${[
          m.scope.code_ref ? `code_ref=${m.scope.code_ref}` : null,
          m.scope.task_contains ? `task~${m.scope.task_contains}` : null,
        ]
          .filter(Boolean)
          .join(", ")})`
      : "";
    return `- **${m.priority.toUpperCase()}** [${target}]${scopeStr} from ${m.from_session.slice(0, 8)} ${age} ago: ${m.body}`;
  });

  return `Drained ${msgs.length} message(s):\n${lines.join("\n")}`;
}

function ageOf(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export interface UpdateSessionTaskArgs {
  session_id: string;
  task: string;
}

export function handleUpdateSessionTask(
  tracker: SessionTracker,
  args: UpdateSessionTaskArgs
): string {
  tracker.updateCurrentTask(args.session_id, args.task);
  return `Current task updated.`;
}
```

- [ ] **Step 2:** Commit.

```bash
git add mcp/tools/messaging.ts
git commit -m "feat(orchestrator): R6 messaging tool handlers"
```

### Task 7: Register the three new agent-callable tools in `server.ts`

**Files:**
- Modify: `mcp/server.ts` (after the last `server.tool(` block, around line 1561)

- [ ] **Step 1:** Add imports near the top.

```typescript
import {
  handleSendMessage,
  handleReadMessages,
  handleUpdateSessionTask,
} from "./tools/messaging";
import { loadInboxCounters } from "./engine/messaging";
```

- [ ] **Step 2:** Register the tools. Place after the existing tool registrations.

```typescript
server.tool(
  "send_message",
  "Leave a message for another active Claude session, or broadcast to all active sessions. Messages are delivered via hooks at every model-think boundary (PostToolUse, UserPromptSubmit, Stop, etc.) so the recipient sees them with minimal delay. Use this when you've discovered something a sibling session needs to know, or when you need to coordinate work that's actively happening in another window.",
  {
    body: z.string().min(1).max(4000),
    to_session: z
      .string()
      .optional()
      .describe("Recipient session_id. Omit for broadcast to all active siblings."),
    scope_code_ref: z
      .string()
      .optional()
      .describe(
        "Optional file/module path. The recipient hook may filter delivery to sessions that touch this path."
      ),
    scope_task_contains: z
      .string()
      .optional()
      .describe(
        "Optional substring; only sessions whose current_task contains it should treat the message as relevant."
      ),
    priority: z.enum(["low", "normal", "high"]).optional(),
    ttl_seconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional time-to-live; expired messages are silently dropped."),
    session_id: z.string().optional().describe("Sender session_id. Defaults to fallback."),
  },
  async (args) => {
    const from = resolveSessionId(args.session_id);
    if (!from) {
      return {
        content: [{ type: "text" as const, text: "send_message requires a session_id." }],
      };
    }
    const db = getProjectDb();
    const text = handleSendMessage(db, { ...args, from_session: from });
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "read_messages",
  "Drain your inbox of pending inter-session messages. Marks each as read for your session_id. Hooks call this automatically when peekInbox shows pending messages; you rarely need to call it directly, but you can to flush the queue mid-task.",
  { session_id: z.string().optional() },
  async (args) => {
    const sid = resolveSessionId(args.session_id);
    if (!sid) {
      return { content: [{ type: "text" as const, text: "read_messages requires a session_id." }] };
    }
    const db = getProjectDb();
    const text = handleReadMessages(db, { session_id: sid });
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "update_session_task",
  "Broadcast what you're currently working on. Sibling sessions see this in their next briefing's Cross-Session Activity AND in lightweight hook-time injections. Call when you start a major task; the activity awareness is what lets sibling agents know they're not alone in the codebase.",
  { task: z.string().min(1).max(500), session_id: z.string().optional() },
  async (args) => {
    const sid = resolveSessionId(args.session_id);
    if (!sid || !sessionTracker) {
      return {
        content: [{ type: "text" as const, text: "update_session_task requires a session_id and active tracker." }],
      };
    }
    const text = handleUpdateSessionTask(sessionTracker, { session_id: sid, task: args.task });
    return { content: [{ type: "text" as const, text }] };
  }
);
```

- [ ] **Step 3:** Wire `loadInboxCounters` into MCP boot. Find the existing initialization block in `server.ts` (after `getProjectDb()` is first called) and add:

```typescript
// R6: prime the in-memory inbox counter map so the fast path in
// peekInbox can answer hook calls without touching the DB on every
// turn boundary.
loadInboxCounters(getProjectDb());
```

- [ ] **Step 4:** Commit.

```bash
git add mcp/server.ts
git commit -m "feat(orchestrator): R6 register send_message / read_messages / update_session_task"
```

---

## Phase 4 — Hook Dispatcher Tool

### Task 8: Create `mcp/tools/hook_event.ts`

**Files:**
- Create: `mcp/tools/hook_event.ts`

- [ ] **Step 1:** Write the dispatcher.

```typescript
import type { Database } from "bun:sqlite";
import { peekInbox, drainInbox } from "../engine/messaging";
import type { SessionTracker } from "../engine/session_tracker";
import { now } from "../utils";

/**
 * Hook event names mirror Claude Code's hook event surface. Each branch
 * is responsible for the entire response shape (additionalContext,
 * permissionDecision, decision:"block", systemMessage, etc.) for that
 * event. Returning {} is the fast path — empty JSON output to stdout
 * = no token cost to the model.
 */
export type HookEvent =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreCompact"
  | "Stop"
  | "SubagentStop";

export interface HookEventArgs {
  event: HookEvent;
  session_id: string;
  tool_name?: string;
  agent_id?: string;
  /** Anything the hook wants to pass through (file_path on PreToolUse Edits, etc). */
  payload?: Record<string, unknown>;
}

export interface HookEventResponse {
  /** Plain markdown injected into the model's next think turn. Omit when nothing to say. */
  additionalContext?: string;
  /** PreToolUse only. */
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  /** Stop / SubagentStop only. */
  decision?: "block";
  reason?: string;
  /** PreCompact only. */
  systemMessage?: string;
}

const VARIANTS = [
  "[orch] REFLECT on last turn: did you note decisions, capture patterns, update work items, or close threads? THEN for this turn: lookup needed? Scan the every-turn action table.",
  "[orch] What prior decisions or anti-patterns apply here? Call lookup before editing unfamiliar code. Capture new knowledge the moment it appears.",
  "[orch] Discipline check: knowledge captured this session so far? If you are about to touch new code, check_similar first. Do not rationalize skipping the action table.",
  "[orch] Mid-session nudge: user preferences, anti-patterns, and decisions are easiest to lose. If any surfaced last turn, note() them NOW before context shifts.",
  "[orch] Lookups before writes, notes as you go. 'I will capture it later' is the top cause of knowledge loss. Later is now.",
  "[orch] Toolkit scan: briefing, lookup, note, check_similar, plan, save_progress, close_thread, update_note, supersede_note. Which one fits this turn before acting? code_refs: [paths] on note/update_note when the knowledge is about specific files.",
  "[orch] Struggle detector: if you are editing code you just edited, or hitting the same error twice, STOP and invoke orchestrator:consult-concierge. Do not hammer.",
  "[orch] Past-self continuity: what you learn this turn only helps future sessions if you note() it. Context windows are temporary, the knowledge base is permanent.",
  "[orch] Work-item hygiene: did a tracked item just change status? update_work_item. New work identified? create_work_item. Do not rely on memory across turns.",
  "[orch] Completeness check: if this turn is a list, inventory, or audit, use list_work_items or orchestrator:consult-concierge. Direct lookup misses items with different vocabulary.",
  "[orch] Capturing knowledge about specific code? Add code_refs: [paths] so future agents find this note via lookup({code_ref: 'path'}) when they touch the same file.",
  "[orch] Editing a non-trivial file? Before diving in, try lookup({code_ref: 'path/to/file'}) to pull notes breadcrumb-tagged with that exact path.",
];

interface HookCtx {
  db: Database;
  tracker: SessionTracker;
}

export function handleHookEvent(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  switch (args.event) {
    case "UserPromptSubmit":
      return handleUserPromptSubmit(ctx, args);
    case "PreToolUse":
      return handlePreToolUse(ctx, args);
    case "PostToolUse":
      return handlePostToolUse(ctx, args);
    case "PostToolUseFailure":
      return handlePostToolUseFailure(ctx, args);
    case "PreCompact":
      return handlePreCompact(ctx, args);
    case "Stop":
    case "SubagentStop":
      return handleStop(ctx, args);
    default:
      return {};
  }
}

// ── Per-event handlers ──────────────────────────────────────────────────

function handleUserPromptSubmit(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  ctx.tracker.registerSession(args.session_id);
  const turn = ctx.tracker.nextTurn(args.session_id);

  const reminder = VARIANTS[(turn - 1) % VARIANTS.length];
  const messages = drainIfPending(ctx, args.session_id);
  const siblingLine = renderSiblingActivity(ctx, args.session_id);

  const parts: string[] = [reminder];
  if (siblingLine) parts.push(siblingLine);
  if (messages) parts.push(messages);

  return { additionalContext: parts.join("\n\n") };
}

function handlePreToolUse(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Lightweight inbox check on every PreToolUse - if scope.code_ref matches
  // the file being edited, deliver immediately (warns BEFORE the write).
  const filePath = (args.payload?.file_path as string | undefined) ?? null;
  if (filePath) {
    const scoped = drainCodeScopedMessages(ctx, args.session_id, filePath);
    if (scoped) return { additionalContext: scoped };
  }
  // Otherwise fast path: skip Option-B escalation logic — that lived in the
  // old bash hook and is preserved by R6 on a future task if Jarid wants it.
  return {};
}

function handlePostToolUse(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Densest delivery surface. O(1) fast path via in-memory counter.
  const messages = drainIfPending(ctx, args.session_id);
  if (messages) return { additionalContext: messages };
  return {};
}

function handlePostToolUseFailure(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Struggle counter lives in plugin_state for this session.
  const key = `struggle_${args.session_id}`;
  const row = ctx.db
    .query(`SELECT value FROM plugin_state WHERE key = ?`)
    .get(key) as { value: string } | null;
  const next = (row ? parseInt(row.value, 10) : 0) + 1;
  ctx.db.run(
    `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(next), now()]
  );

  if (next < 2) return {};
  if (next >= 3) {
    return {
      additionalContext: `[orch] STOP. ${next} consecutive tool failures. Invoke orchestrator:consult-concierge NOW with: (1) what you are trying to accomplish, (2) what you have tried, (3) what errors you are seeing.`,
    };
  }
  return {
    additionalContext: `[orch] Two tool calls failed in a row. Before trying a third approach, consider invoking orchestrator:consult-concierge.`,
  };
}

function handlePreCompact(_ctx: HookCtx, _args: HookEventArgs): HookEventResponse {
  return {
    systemMessage:
      "Context compaction imminent. Before your window shrinks, capture any uncaptured knowledge NOW: call save_progress for current state, note() for decisions/gotchas/patterns discovered this session, update_note / supersede_note for corrections, close_thread for resolved threads.",
  };
}

function handleStop(ctx: HookCtx, args: HookEventArgs): HookEventResponse {
  // Once per session id (per Stop or SubagentStop): block once, then
  // future Stop hooks pass through. Reuse plugin_state with a marker key.
  const key = args.event === "Stop" ? `stop_${args.session_id}` : `subagent_stop_${args.session_id}`;
  const exists = ctx.db
    .query(`SELECT 1 FROM plugin_state WHERE key = ?`)
    .get(key);
  if (exists) return {};
  ctx.db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`,
    [key, now()]
  );

  // Reuse the existing maintenance prompt text. Keep this paragraph short -
  // the surface is the same one users have been seeing from the bash hook.
  const reason = `Before ending this session, complete orchestrator housekeeping. Maintenance verbs are equal-priority to capture - a session that only captures grows the corpus; a session that also maintains makes the knowledge base more accurate and faster to traverse over time.

1. Curate (update_note / close_thread / supersede_note) - lookup results you used: still correct? settled? fix stale notes now.
2. Capture (note) - decisions, conventions, anti-patterns, architecture, risks, insights, user preferences. For code-specific notes, pass code_refs: [paths].
3. save_progress with summary, open questions, next steps.
4. Retro is automatic - auto-fires from briefing on a 7-day cadence.

The orchestrator is a living knowledge base, not an append-only log.`;
  return { decision: "block", reason };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function drainIfPending(ctx: HookCtx, sessionId: string): string {
  const peek = peekInbox(ctx.db, sessionId);
  if (peek.count === 0) return "";
  const msgs = drainInbox(ctx.db, sessionId);
  if (msgs.length === 0) return "";
  const lines = msgs.map((m) => {
    const tag = m.priority === "high" ? "🔴" : m.priority === "low" ? "·" : "•";
    const where = m.to_session ? "direct" : "broadcast";
    return `${tag} [${where} from ${m.from_session.slice(0, 8)}]: ${m.body}`;
  });
  return `### Inter-session messages (${msgs.length})\n${lines.join("\n")}`;
}

function drainCodeScopedMessages(ctx: HookCtx, sessionId: string, filePath: string): string {
  const msgs = drainInbox(ctx.db, sessionId);
  if (msgs.length === 0) return "";
  // Filter to messages whose scope.code_ref matches and re-insert any non-matching
  // back into the queue (effectively un-marking by deleting the read record).
  const matching = msgs.filter((m) => m.scope?.code_ref && filePath.includes(m.scope.code_ref));
  const others = msgs.filter((m) => !m.scope?.code_ref || !filePath.includes(m.scope.code_ref));
  if (others.length > 0) {
    db_unmarkRead(ctx.db, sessionId, others.map((m) => m.id));
  }
  if (matching.length === 0) return "";
  const lines = matching.map((m) => `🔧 [scoped to ${m.scope!.code_ref}] from ${m.from_session.slice(0, 8)}: ${m.body}`);
  return `### Code-scoped messages for ${filePath}\n${lines.join("\n")}`;
}

function db_unmarkRead(db: Database, sessionId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.run(
    `DELETE FROM session_message_reads WHERE session_id = ? AND msg_id IN (${placeholders})`,
    [sessionId, ...ids]
  );
}

function renderSiblingActivity(ctx: HookCtx, sessionId: string): string {
  const sibs = ctx.tracker.getActiveSiblings(sessionId);
  if (sibs.length === 0) return "";
  const lines = sibs.map((s) => {
    const id = s.session_id.slice(0, 8);
    const task = s.current_task ? `: ${s.current_task.slice(0, 80)}` : ": (no task set)";
    return `  - ${id}${task}`;
  });
  return `[orch] ${sibs.length} sibling session${sibs.length > 1 ? "s" : ""} active:\n${lines.join("\n")}`;
}
```

- [ ] **Step 2:** Commit.

```bash
git add mcp/tools/hook_event.ts
git commit -m "feat(orchestrator): R6 hook_event dispatcher with O(1) fast path"
```

### Task 9: Register `_hook_event` tool in `server.ts`

**Files:**
- Modify: `mcp/server.ts`

- [ ] **Step 1:** Add import.

```typescript
import { handleHookEvent, type HookEvent } from "./tools/hook_event";
```

- [ ] **Step 2:** Register the tool. The leading `_` flags it as internal-use so the agent doesn't call it directly.

```typescript
server.tool(
  "_hook_event",
  "Internal: dispatcher invoked from Claude Code hooks via type:'mcp_tool'. Routes per event_name. Returns hookSpecificOutput-shaped JSON. Agents should not call this directly.",
  {
    event: z.enum([
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "Stop",
      "SubagentStop",
    ]),
    session_id: z.string(),
    tool_name: z.string().optional(),
    agent_id: z.string().optional(),
    file_path: z.string().optional(),
  },
  async (args) => {
    if (!sessionTracker) {
      return { content: [{ type: "text" as const, text: "{}" }] };
    }
    const db = getProjectDb();
    const result = handleHookEvent(
      { db, tracker: sessionTracker },
      {
        event: args.event as HookEvent,
        session_id: args.session_id,
        tool_name: args.tool_name,
        agent_id: args.agent_id,
        payload: args.file_path ? { file_path: args.file_path } : undefined,
      }
    );

    // Build the hookSpecificOutput envelope per Claude Code's hook contract.
    const envelope: Record<string, unknown> = {
      hookSpecificOutput: { hookEventName: args.event },
    };
    const hso = envelope.hookSpecificOutput as Record<string, unknown>;
    if (result.additionalContext) hso.additionalContext = result.additionalContext;
    if (result.permissionDecision) {
      hso.permissionDecision = result.permissionDecision;
      if (result.permissionDecisionReason) hso.permissionDecisionReason = result.permissionDecisionReason;
    }
    if (result.decision === "block") {
      envelope.decision = "block";
      if (result.reason) envelope.reason = result.reason;
    }
    if (result.systemMessage) envelope.systemMessage = result.systemMessage;

    // Return JSON text so Claude Code parses and applies the directives.
    return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }] };
  }
);
```

- [ ] **Step 3:** Commit.

```bash
git add mcp/server.ts
git commit -m "feat(orchestrator): R6 register _hook_event dispatcher tool"
```

---

## Phase 5 — Hooks Migration

### Task 10: Rewrite `hooks/hooks.json` to use `mcp_tool` for the 7 migrated hooks

**Files:**
- Modify: `hooks/hooks.json`

- [ ] **Step 1:** Replace the file contents.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-start"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "memory",
            "tool": "_hook_event",
            "input": { "event": "UserPromptSubmit", "session_id": "${session_id}" }
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "memory",
            "tool": "_hook_event",
            "input": {
              "event": "PreToolUse",
              "session_id": "${session_id}",
              "tool_name": "${tool_name}",
              "file_path": "${tool_input.file_path}"
            }
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "memory",
            "tool": "_hook_event",
            "input": {
              "event": "PostToolUse",
              "session_id": "${session_id}",
              "tool_name": "${tool_name}"
            }
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Write|Edit|MultiEdit|Bash|mcp__.*",
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "memory",
            "tool": "_hook_event",
            "input": {
              "event": "PostToolUseFailure",
              "session_id": "${session_id}",
              "tool_name": "${tool_name}"
            }
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "memory",
            "tool": "_hook_event",
            "input": { "event": "PreCompact", "session_id": "${session_id}" }
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "memory",
            "tool": "_hook_event",
            "input": { "event": "Stop", "session_id": "${session_id}" }
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "memory",
            "tool": "_hook_event",
            "input": { "event": "SubagentStop", "session_id": "${session_id}", "agent_id": "${agent_id}" }
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2:** Commit.

```bash
git add hooks/hooks.json
git commit -m "feat(orchestrator): R6 migrate 7 hooks to type:mcp_tool"
```

### Task 11: Delete the now-unused bash hook scripts and `_lib.sh`

**Files:**
- Delete: `hooks/user-prompt-submit`
- Delete: `hooks/pre-tool-use`
- Delete: `hooks/post-tool-use`
- Delete: `hooks/post-tool-use-failure`
- Delete: `hooks/pre-compact`
- Delete: `hooks/stop`
- Delete: `hooks/subagent-stop`
- Delete: `hooks/_lib.sh`
- Delete: `hooks/run-hook.cmd`

- [ ] **Step 1:**

```bash
rm hooks/user-prompt-submit hooks/pre-tool-use hooks/post-tool-use hooks/post-tool-use-failure hooks/pre-compact hooks/stop hooks/subagent-stop hooks/_lib.sh hooks/run-hook.cmd
```

- [ ] **Step 2:** Commit.

```bash
git add -A hooks/
git commit -m "chore(orchestrator): R6 remove migrated bash hooks (logic now in _hook_event)"
```

### Task 12: Slim `hooks/session-start` to drop state-dir cleanup

**Files:**
- Modify: `hooks/session-start`

- [ ] **Step 1:** Rewrite. Keep only the boot directive and session_id banner — the state-dir cleanup is gone (no more state dir).

```bash
#!/usr/bin/env bash
set -euo pipefail

# SessionStart stays bash because the MCP server may not be connected yet
# at the moment this hook fires (cold-start race). Emits the boot directive
# and surfaces session_id to the agent. All other hook logic moved to the
# _hook_event MCP tool dispatcher in R6.

EVENT_TYPE="${CLAUDE_HOOK_EVENT_NAME:-startup}"
case "$EVENT_TYPE" in
  compact) ORIENT_EVENT="compact" ;;
  clear)   ORIENT_EVENT="clear" ;;
  resume)  ORIENT_EVENT="resume" ;;
  *)       ORIENT_EVENT="startup" ;;
esac

INPUT=""
if [ ! -t 0 ]; then INPUT=$(cat 2>/dev/null || printf ''); fi

SID=""
if [ -n "$INPUT" ]; then
  SID=$(printf '%s' "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4 || printf '')
  case "$SID" in
    *[!a-zA-Z0-9_-]*|"") SID="" ;;
  esac
fi

# Persist to fallback file - the MCP server reads this when an agent forgets
# to pass session_id. Path matches getFallbackSessionId in server.ts.
if [ -n "$SID" ] && [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  STATE_DIR="$CLAUDE_PROJECT_DIR/.orchestrator-state"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '%s' "$SID" > "$STATE_DIR/active-session" 2>/dev/null || true
  if [ ! -f "$STATE_DIR/.gitignore" ]; then printf '*\n' > "$STATE_DIR/.gitignore" 2>/dev/null || true; fi
fi

SID_LINE=""
if [ -n "$SID" ]; then
  SID_LINE="\\n\\nYour session ID for this conversation is: ${SID}\\nPass this as \\\`session_id\\\` on EVERY orchestrator tool call. It enables cross-session discovery so sibling sessions see what you create and you see what they're working on."
fi

CONTEXT="MANDATORY FIRST ACTIONS: (1) Call \\\`briefing\\\` with event \\\"${ORIENT_EVENT}\\\" AND session_id set. (2) Invoke \\\`orchestrator:getting-started\\\`. (3) From now on, invoke \\\`orchestrator:every-turn\\\` EVERY turn before and after acting. These are not optional.${SID_LINE}"

# Bash JSON escape: backslash, quote, newline, tab, control chars.
ESC="$CONTEXT"
ESC="${ESC//\\/\\\\}"
ESC="${ESC//\"/\\\"}"
ESC="${ESC//$'\n'/\\n}"
ESC="${ESC//$'\r'/\\r}"
ESC="${ESC//$'\t'/\\t}"

cat <<EOF
{
  "additional_context": "${ESC}",
  "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "${ESC}" }
}
EOF

exit 0
```

- [ ] **Step 2:** Commit.

```bash
git add hooks/session-start
git commit -m "refactor(orchestrator): R6 slim session-start, drop state-dir cleanup"
```

### Task 13: Phase 5 verification

- [ ] **Step 1:** Build the bundled server: `bun run build`. Expected: clean build, no type errors.

- [ ] **Step 2:** Run all tests: `bun test`. Expected: all pre-existing tests still pass + new messaging tests pass.

- [ ] **Step 3:** If any failure, fix before moving on.

---

## Phase 6 — Integration Test

### Task 14: Two-session round-trip integration test

**Files:**
- Create: `tests/integration/cross_session_messaging.test.ts`

- [ ] **Step 1:** Write the test.

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { SessionTracker } from "../../mcp/engine/session_tracker";
import { handleHookEvent } from "../../mcp/tools/hook_event";
import { sendMessage, _resetMessagingForTest, loadInboxCounters } from "../../mcp/engine/messaging";

describe("cross-session messaging integration", () => {
  test("session A sends -> session B receives via PostToolUse hook", () => {
    _resetMessagingForTest();
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const tracker = new SessionTracker(db);
    tracker.registerSession("A");
    tracker.registerSession("B");

    sendMessage(db, { from_session: "A", to_session: "B", body: "heads up - touching the same file you are" });

    const result = handleHookEvent(
      { db, tracker },
      { event: "PostToolUse", session_id: "B", tool_name: "Edit" }
    );

    expect(result.additionalContext).toContain("heads up");
    expect(result.additionalContext).toContain("from A");
  });

  test("UserPromptSubmit injects sibling activity when present", () => {
    _resetMessagingForTest();
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const tracker = new SessionTracker(db);
    tracker.registerSession("X");
    tracker.registerSession("Y");
    tracker.updateCurrentTask("Y", "refactoring observer connect");

    const result = handleHookEvent(
      { db, tracker },
      { event: "UserPromptSubmit", session_id: "X" }
    );

    expect(result.additionalContext).toContain("refactoring observer connect");
  });

  test("fast path: no messages, no siblings -> minimal context", () => {
    _resetMessagingForTest();
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const tracker = new SessionTracker(db);
    tracker.registerSession("solo");
    loadInboxCounters(db);

    const result = handleHookEvent(
      { db, tracker },
      { event: "PostToolUse", session_id: "solo", tool_name: "Read" }
    );

    // PostToolUse with empty inbox returns no additionalContext at all -
    // the model pays zero token cost for the hook on idle turns.
    expect(result.additionalContext).toBeUndefined();
  });

  test("Stop blocks once per session, then passes through", () => {
    _resetMessagingForTest();
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const tracker = new SessionTracker(db);
    tracker.registerSession("S");

    const first = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "S" });
    expect(first.decision).toBe("block");

    const second = handleHookEvent({ db, tracker }, { event: "Stop", session_id: "S" });
    expect(second.decision).toBeUndefined();
  });
});
```

- [ ] **Step 2:** Run: `bun test tests/integration/cross_session_messaging.test.ts`. All 4 should pass.

- [ ] **Step 3:** Commit.

```bash
git add tests/integration/cross_session_messaging.test.ts
git commit -m "test(orchestrator): R6 cross-session integration tests"
```

---

## Phase 7 — Docs and Version Bump

### Task 15: Add R6 entry to `docs/DECISIONS.md`

**Files:**
- Modify: `docs/DECISIONS.md` (prepend entry above the most recent R5.1 entry)

- [ ] **Step 1:** Insert this entry at the top (after the file header).

```markdown
## 2026-04-28 - R6 cross-session inter-agent messaging

**Change.** New `session_messages` + `session_message_reads` tables (migration 19), three new agent-callable MCP tools (`send_message`, `read_messages`, `update_session_task`), one internal `_hook_event` dispatcher tool, and migration of 7 of 8 bash hooks to `type: "mcp_tool"`. Hooks call `_hook_event` which routes per event name and returns `hookSpecificOutput` with optional `additionalContext`/`permissionDecision`/`decision:"block"`. Inbox uses an in-memory counter map for the O(1) fast path; DB is touched only when there are pending messages or stale counters. `session-start` stays bash to dodge the cold-start race where the MCP server may not be connected yet.

**Rationale.** Pre-R6, sibling sessions could see each other's *captured* notes via cross_session in briefing, but had no way to actively coordinate. The `current_task` column existed but nothing wrote to it. There was no inbox primitive. Cross-session communication was effectively passive and turn-boundary-only. R6 makes it active and dense: PostToolUse + UserPromptSubmit + PreToolUse + Stop + SubagentStop combined hit every model-think boundary, so a message left by session A is visible to session B at the next tool call. The in-memory counter keeps the per-hook cost at O(1) when nothing is pending, satisfying the "token-light when idle" constraint.

The bash-to-mcp_tool migration is bundled into R6 because (a) the new functionality belongs in TypeScript with shared DB access anyway, and (b) keeping bash hooks alongside mcp_tool hooks for the same plugin is incoherent — one substrate, not two. Per Jarid's "complete removals in one pass" pattern, decoupling-then-removing-later was rejected.

**Rejected.**
- Migrating SessionStart to mcp_tool — cold-start race; the MCP server may not be connected yet at first session boot. The hook produces a non-blocking error per changelog line 150 docs, but losing the boot directive is a real UX regression. Keeping bash here costs 30 lines and has no downside.
- Separate per-event MCP tools (`hook_user_prompt_submit`, `hook_pre_tool_use`, ...) — pollutes the agent-visible tool list with internal tools. Single `_hook_event` dispatcher with `_` prefix is cleaner.
- Per-message `read_at` column without a separate `session_message_reads` table — works for direct messages but breaks for broadcasts (one row, many recipients). The reads table normalizes both.
- WebSocket / pub-sub between MCP servers — over-engineered for the cardinality (handful of concurrent sessions per project). DB + in-memory counter is enough.
- Polling MCP server in a background loop — Claude Code agents have no event loop while idle; only hooks can deliver context to a thinking model.
- Forwarding via Claude Code's `SendMessage` primitive — confirmed in the changelog to be agent-teams-only and intra-session. Cannot cross between two separately-spawned Claude Code processes.

**Shipped:** v0.26.0.
```

- [ ] **Step 2:** Commit.

```bash
git add docs/DECISIONS.md
git commit -m "docs(orchestrator): R6 DECISIONS.md entry"
```

### Task 16: Update `docs/ARCHITECTURE.md`

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1:** Add `messaging.ts` to the engine listing in the top-level layout block. Add `messaging.ts` and `hook_event.ts` under `tools/`. Update the "Engine components" section with a `### messaging.ts` subsection. Update the "Hook flow" table to mention that 7/8 hooks use `mcp_tool` dispatch via `_hook_event`. Update the `MCP tool surface` count from 19 to 22 (added send_message, read_messages, update_session_task) plus the internal `_hook_event`. Update migration count from 18 to 19.

(See the existing structure in `docs/ARCHITECTURE.md` lines 7-41 for the layout block and lines 152-215 for the engine descriptions.)

- [ ] **Step 2:** Commit.

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(orchestrator): R6 ARCHITECTURE.md updates - messaging engine + hook dispatcher"
```

### Task 17: Bump version to `0.26.0`

**Files:**
- Modify: `.claude-plugin/plugin.json` (`version`)
- Modify: `package.json` (`version`)

- [ ] **Step 1:** Update both files. `0.25.2` → `0.26.0` (R-class minor bump per orchestrator's existing convention).

- [ ] **Step 2:** Commit.

```bash
git add .claude-plugin/plugin.json package.json
git commit -m "chore(orchestrator): bump 0.25.2 -> 0.26.0 for R6"
```

### Task 18: Final verification

- [ ] **Step 1:** `bun run build` (full bundled server build).

- [ ] **Step 2:** `bun test` (all tests, including pre-existing).

- [ ] **Step 3:** `bun run typecheck` (tsc --noEmit).

All three must pass before the work is considered done.

---

## Self-Review Notes

**Spec coverage** — every requirement from the conversation is mapped:
- Inter-session messaging with broadcast + targeted + scoped → Tasks 1, 2, 6, 7
- Activity awareness via `current_task` → Tasks 3, 7 (`update_session_task`)
- mcp_tool migration of all bash hooks where it makes sense → Tasks 8, 9, 10, 11, 12
- Token-light fast path when no messages → Task 2 (in-memory counter), Task 8 (handlePostToolUse early-return), Task 14 (fast-path test)
- "Most realtime" delivery via PostToolUse `.*` matcher → Task 10
- Code-scoped messages (R5 reverse-index reuse) → Task 8 (`drainCodeScopedMessages`), Task 10 (PreToolUse with file_path)
- Tests prove send/receive round-trip → Task 14
- Docs land alongside code → Tasks 15, 16

**Type/name consistency** — `_hook_event`, `send_message`, `read_messages`, `update_session_task` are used identically across server.ts registration, hooks.json input.tool, and tools/messaging.ts handlers. `MessageScope`, `MessagePriority`, `SessionMessage` types are defined once in `engine/messaging.ts` and re-exported through `tools/messaging.ts`.

**No placeholders** — every step has the actual code or the actual diff. Two areas where I deferred to "see the existing structure" rather than re-pasting (Task 16 ARCHITECTURE.md surgical edits) — those are textual edits where pasting the full file would be noise. Task 7 / 9 server.ts insertions specify line ranges and surrounding anchors.

**Open question for Jarid before execute:** the PreToolUse "Option B escalation" (turn-counter-driven nag for sessions that haven't called any orchestrator tool by turn 4) is dropped in this plan because it's tangential to the messaging feature. We can preserve it in a future task if you want — the dispatcher already has the hook event branch, just no logic in it. Flag if this should ship in R6 instead of being deferred.
