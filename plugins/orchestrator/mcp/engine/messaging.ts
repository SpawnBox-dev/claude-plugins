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

// Per-process in-memory unread count per recipient session id. Drives the
// O(1) fast path for `peekInbox` so the hook can return an empty response
// without touching the DB when the inbox is empty. Populated at MCP server
// boot (loadInboxCounters) and maintained incrementally by sendMessage and
// drainInbox. The slow path (drainInbox) always trusts the DB, so missed
// counter bumps from sibling processes cause delayed delivery, not lost
// messages.
//
// R7.5: dropped from 30s to 5s. The 30s window was generous for an
// inter-agent coordination tool whose densest delivery surface is
// PostToolUse `.*`. Plus opportunistic per-session re-check below: when
// peekInbox sees a 0-entry already in the Map, it does a single indexed
// SELECT to confirm. Truly idle sessions still pay zero cost (no Map entry
// = no opportunistic check fired); only sessions known to have polled the
// inbox eat the small extra check.
const inboxCounters = new Map<string, number>();
let lastCounterRefreshAt = 0;
const COUNTER_REFRESH_INTERVAL_MS = 5_000;

export function loadInboxCounters(db: Database): void {
  // Per-session unread = direct messages targeted at the session that the
  // session hasn't read yet, PLUS broadcast messages the session hasn't read
  // yet. Computed in two queries and merged - cheaper than a single UNION
  // ALL with COALESCE that would force a JOIN against session_registry.
  const ts = now();

  const directRows = db
    .query(
      `SELECT m.to_session AS recipient, COUNT(*) AS cnt
       FROM session_messages m
       WHERE m.to_session IS NOT NULL
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND NOT EXISTS (
           SELECT 1 FROM session_message_reads r
           WHERE r.msg_id = m.id AND r.session_id = m.to_session
         )
       GROUP BY m.to_session`
    )
    .all(ts) as Array<{ recipient: string; cnt: number }>;

  const broadcastRows = db
    .query(
      `SELECT sr.session_id AS recipient, COUNT(*) AS cnt
       FROM session_registry sr
       JOIN session_messages m ON m.to_session IS NULL
       WHERE m.from_session != sr.session_id
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND NOT EXISTS (
           SELECT 1 FROM session_message_reads r
           WHERE r.msg_id = m.id AND r.session_id = sr.session_id
         )
       GROUP BY sr.session_id`
    )
    .all(ts) as Array<{ recipient: string; cnt: number }>;

  inboxCounters.clear();
  for (const r of directRows) inboxCounters.set(r.recipient, r.cnt);
  for (const r of broadcastRows) {
    inboxCounters.set(r.recipient, (inboxCounters.get(r.recipient) ?? 0) + r.cnt);
  }
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

  if (input.to_session) {
    inboxCounters.set(input.to_session, (inboxCounters.get(input.to_session) ?? 0) + 1);
  } else {
    // Broadcast: bump every active sibling so their hook fast path picks
    // up the message at next think boundary. Use a 24h "active" window to
    // match the cross_session briefing definition.
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

// O(1) check for pending messages. Falls back to DB query at most once per
// COUNTER_REFRESH_INTERVAL_MS (5s) to recover from sibling-process writes
// the in-memory counter missed.
//
// R7.5 opportunistic re-check: if the Map has a 0-entry for this session
// (i.e. we polled before and saw empty), confirm with a single indexed
// SELECT against session_messages. Closes the cross-process drift window
// for sessions actively polling without forcing the global refresh on every
// call. Truly idle sessions (no Map entry) skip the check entirely - they
// still hit the global refresh path on the 5s cadence.
export function peekInbox(db: Database, sessionId: string): PeekResult {
  maybeRefreshCounters(db);
  const cached = inboxCounters.get(sessionId);
  if (cached === undefined || cached > 0) {
    return { count: cached ?? 0 };
  }
  // Cached 0 - do a cheap indexed confirmation. Single LIMIT 1 against an
  // index, sub-millisecond at expected cardinality.
  const ts = now();
  const row = db
    .query(
      `SELECT m.id FROM session_messages m
       WHERE (m.to_session = ? OR m.to_session IS NULL)
         AND m.from_session != ?
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND NOT EXISTS (
           SELECT 1 FROM session_message_reads r
           WHERE r.msg_id = m.id AND r.session_id = ?
         )
       LIMIT 1`
    )
    .get(sessionId, sessionId, ts, sessionId);
  if (row) {
    // Cross-process write missed our counter - fix it. We don't know the
    // exact count without a COUNT(*) query, so set to 1 (sentinel) - drain
    // will compute the truth.
    inboxCounters.set(sessionId, 1);
    return { count: 1 };
  }
  return { count: 0 };
}

export interface DrainContext {
  /** Recipient's currently-edited file path, if any. Used to match scope.code_ref. */
  currentFilePath?: string;
  /** Recipient's current_task string, if any. Used to substring-match scope.task_contains. */
  currentTask?: string;
}

/**
 * Drain inbox with optional scope filtering. Messages whose scope matches
 * the recipient's context are delivered and marked read; messages whose
 * scope does NOT match are LEFT UNREAD - they'll be eligible for delivery
 * on a future call where the context matches. Unscoped messages always
 * deliver.
 *
 * Match rules (R7.5):
 * - scope.code_ref: matches if `currentFilePath` contains scope.code_ref
 *   as a substring. Allows file (`src/foo.ts`) or directory (`src/foo/`)
 *   breadcrumbs to match nested paths the recipient is editing.
 * - scope.task_contains: matches if `currentTask` contains the substring
 *   (case-insensitive).
 * - Both fields present: any-match (OR), so a message tagged with both is
 *   delivered when either matches the recipient's context.
 * - Neither field present (scope = null): always delivers (unscoped).
 */
export function drainInbox(
  db: Database,
  sessionId: string,
  context?: DrainContext
): SessionMessage[] {
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
         created_at`
    )
    .all(sessionId, sessionId, ts, sessionId) as Array<{
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

  // R7.5: split into eligible (matches scope or has none) vs deferred
  // (scoped but no match in current context). Mark only eligible as read.
  // Pre-parse scope once; malformed JSON is treated as unscoped (no get-stuck).
  type EligibleRow = (typeof rows)[number] & { parsedScope: MessageScope | null };
  const eligible: EligibleRow[] = [];
  let deferred = 0;
  for (const r of rows) {
    let parsedScope: MessageScope | null = null;
    if (r.scope) {
      try {
        parsedScope = JSON.parse(r.scope) as MessageScope;
      } catch {
        // Malformed scope - treat as unscoped to avoid getting stuck.
        parsedScope = null;
      }
    }
    if (parsedScope === null || matchesScope(parsedScope, context)) {
      eligible.push({ ...r, parsedScope });
    } else {
      deferred++;
    }
  }

  if (eligible.length === 0) {
    // Everything was deferred. Don't write 0 to the counter - we still have
    // pending messages, just none for this context. Set to deferred count
    // so future polls in matching contexts will trigger drain.
    inboxCounters.set(sessionId, deferred);
    return [];
  }

  const insertRead = db.prepare(
    `INSERT OR IGNORE INTO session_message_reads (msg_id, session_id, read_at) VALUES (?, ?, ?)`
  );
  db.run("BEGIN");
  try {
    for (const row of eligible) insertRead.run(row.id, sessionId, ts);
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }

  // Counter reflects what's still pending after this drain.
  inboxCounters.set(sessionId, deferred);

  return eligible.map((r) => ({
    id: r.id,
    from_session: r.from_session,
    to_session: r.to_session,
    scope: r.parsedScope,
    body: r.body,
    priority: r.priority as MessagePriority,
    created_at: r.created_at,
    expires_at: r.expires_at,
  }));
}

function matchesScope(scope: MessageScope, context?: DrainContext): boolean {
  // Empty scope object (no filterable fields) - treat as unscoped.
  if (!scope.code_ref && !scope.task_contains) return true;
  // No context provided - scoped messages can't match anything.
  if (!context) return false;
  if (scope.code_ref && context.currentFilePath) {
    if (context.currentFilePath.includes(scope.code_ref)) return true;
  }
  if (scope.task_contains && context.currentTask) {
    if (context.currentTask.toLowerCase().includes(scope.task_contains.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// Test-only: reset module state between tests so the counter map doesn't
// leak across describe blocks.
export function _resetMessagingForTest(): void {
  inboxCounters.clear();
  lastCounterRefreshAt = 0;
}
