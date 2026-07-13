/**
 * State helpers for the agent-channel subsystem.
 *
 * 0.30.35 (write-stomping fix): consolidated all stateful agent-channel files
 * into a single dedicated SQLite database at
 * `<project>/.orchestrator-state/agent-channel/agent_channel.db` (WAL mode).
 *
 * Why: the prior file-based design used a shared `sessions.json` + `state.json`
 * with read-modify-write pattern via atomicWrite. With N concurrent MCPs (PA +
 * SAs) heartbeating every 30s plus per-tick offsets writes every 1500ms, two
 * writers could read the same snapshot, mutate independently, and the second
 * to write would silently clobber the first's update. Reaper in other SAs
 * then saw the stomped-stale entry and removeSession'd it. Net effect: alive
 * MCP with fresh heartbeat timer became invisible to the fleet for 60-120s.
 * 29+ orphan `*.tmp.*` files in the state dir also showed the atomic-rename
 * retry pattern leaks artifacts under load.
 *
 * SQLite with WAL mode eliminates the race at the storage engine: writers
 * queue atomically via BEGIN IMMEDIATE; readers don't block writers. INSERT
 * OR REPLACE is an atomic upsert with no read-modify-write window. The
 * shared `.tmp.*` artifact class disappears entirely.
 *
 * Tables (one DB, four tables):
 *   sessions       - registry of active sessions (PA + SAs) with heartbeats
 *   global_pause   - singleton row (id=1) for the PA global pause override
 *   sa_pause       - per-SA pause entries (terminal-only mutations)
 *   offsets        - per-(receiver_id8, jsonl_path) byte offsets for the
 *                    filewatcher event bus replay cursor
 *
 * Files NOT in this DB (and why):
 *   system_events.jsonl - cross-MCP event bus, append-only. Filewatcher
 *                         semantics with byte-offset bookkeeping are subtle;
 *                         migrating it bundles too much risk into one ship.
 *                         Tracked separately as a follow-up WI.
 *   active-session-<pid> markers - one-shot startup anchors, no mutation.
 *
 * Migration: each function checks for its legacy file (sessions.json /
 * state.json / offsets-<id8>.json) on entry and migrates if present.
 * Idempotent + race-tolerant across mixed-version MCPs - INSERT OR IGNORE
 * preserves fresher DB rows over stale legacy data, unlinkSync errors are
 * swallowed (another MCP may have raced us). After all MCPs upgrade, the
 * legacy files stop being recreated and disappear after their next migration.
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";

/**
 * Functional classification of an agent session, distinct from `role`.
 *
 * `role` ("prime" / "subordinate") encodes the orchestration position:
 *  who has authority over whom. `kind` encodes WHAT this session is for
 *  so other consumers (skills, classifier policies, briefing renderers)
 *  can gate on identity without resorting to narrative pattern-matching
 *  on session names or inferring from the role alone.
 *
 *  - "prime"        : PA - the project's orchestrator session.
 *  - "subordinate"  : generic SA - the default working session.
 *  - "discord-bot"  : SA specialized for live Discord community ops.
 *                     role is still "subordinate" - kind distinguishes
 *                     it from generic SAs for /discord-bootstrap skill
 *                     identity checks + future per-kind classifier
 *                     allowlists.
 *
 * Set at launch by ORCHESTRATOR_SESSION_KIND (or SPAWNBOX_SESSION_KIND
 * for the legacy prefix). Optional - sessions launched without the env
 * leave it undefined and consumers fall back to role-based heuristics.
 */
export type SessionKind = "prime" | "subordinate" | "discord-bot";

/** PA-coherence primitive (WI 19294811-family): a session's fleet-liveness as
 *  the repurposing query gates on it. `healthy` = reachable; the two `_suspect`
 *  states mean alive-but-not-reachable and are carried with a TTL. */
export type LivenessState = "healthy" | "egress_suspect" | "ingress_suspect";

export interface SessionEntry {
  session_id: string;
  id8: string;
  role: "prime" | "subordinate";
  name: string;
  started_at: string;
  last_heartbeat_at: string;
  current_task?: string | null;
  kind?: SessionKind;
  // --- PA-coherence primitive (design 2026-07-13) -----------------------------
  // These are written ONLY by dedicated setters, NEVER by writeSession (a
  // heartbeat), so they survive the 30s heartbeat cadence. liveness_* in
  // particular is OBSERVER-written (a peer writes it about the subject).
  /** Subsystems/files/WIs this session is warm on (auto-derived floor +
   *  self-declared override). Stored as a JSON array; absent = unknown. */
  warm_context?: string[] | null;
  liveness_state?: LivenessState | null;
  /** ISO-8601 of the freshest observation that set liveness_state (freshest wins). */
  liveness_ts?: string | null;
  /** ISO-8601 TTL for a `_suspect` state (null for healthy). */
  liveness_expires_at?: string | null;
  /** Self-declared intent: `driving` | `holding-for-<X>` | `idle-available` | `parked`. */
  hot_path_status?: string | null;
  /** Self-declared pollution flag: "do NOT steer me, keeping context clean." */
  keep_clean?: boolean | null;
}

export interface OverrideState {
  pa_global_pause: {
    active: boolean;
    since: string | null;
    set_by_session: string | null;
  };
  sa_pauses: Record<string, { since: string; set_by_session: string }>;
}

// Legacy file names - read once during migration, then deleted.
const SESSIONS_FILE = "sessions.json";
const STATE_FILE = "state.json";

// The single SQLite DB that backs all stateful agent-channel data.
const AGENT_CHANNEL_DB_FILE = "agent_channel.db";

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// One-time-per-process stale-tmp sweep guard, keyed by stateDir.
const tmpSweptDirs = new Set<string>();

// Minimum age before a `*.tmp.*` artifact is eligible for sweeping. Atomic
// writes (the retired pre-0.30.35 path) completed in milliseconds, so a
// 5-minute floor is an enormous safety margin: it can never race a write
// that's legitimately in flight, while still reclaiming true debris.
const TMP_SWEEP_MIN_AGE_MS = 5 * 60_000;

/**
 * Best-effort sweep of orphaned `*.tmp.*` atomic-write artifacts in the
 * agent-channel state dir (WI 603dc765).
 *
 * Pre-0.30.35 the file-based design wrote `sessions.json` / `state.json` /
 * `offsets-<id8>.json` via an atomicWrite (write `<name>.tmp.<rand>` then
 * rename). Under Windows EBUSY / AV / OneDrive locks the rename could fail
 * after the temp was written, leaking `*.tmp.*` files that nothing ever
 * reaped - dozens accumulated (see the module header + readSessions/offsets
 * notes). The 0.30.35 SQLite migration removed the atomicWrite path
 * entirely ("the shared .tmp.* artifact class disappears entirely"), so the
 * CURRENT code creates none of these - but it never cleaned up the existing
 * debris, and an old-version MCP in a mixed-version fleet could still add
 * more until it upgrades. This sweep makes the cleanup complete and
 * self-healing: age-gated (only files older than TMP_SWEEP_MIN_AGE_MS, so
 * never an in-flight write), best-effort (every failure swallowed - another
 * process may race the unlink), and run ONCE per process per stateDir (off
 * the getDb first-open path, not the hot loop). It deliberately matches only
 * the `.tmp.` atomic-write infix - the live SQLite `agent_channel.db` and
 * its `-wal`/`-shm`/`-journal` siblings never contain `.tmp.` so they are
 * structurally excluded.
 */
function sweepStaleTmpArtifacts(stateDir: string): void {
  if (tmpSweptDirs.has(stateDir)) return;
  tmpSweptDirs.add(stateDir);
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return; // dir not readable yet - nothing to sweep
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.includes(".tmp.")) continue;
    const full = join(stateDir, name);
    try {
      if (now - statSync(full).mtimeMs < TMP_SWEEP_MIN_AGE_MS) continue;
      unlinkSync(full);
    } catch {
      // race-tolerant / best-effort: another MCP may have unlinked it, or
      // it's momentarily locked. A missed one costs nothing - next process
      // start retries.
    }
  }
}

// === SQLite connection cache ===
//
// One Database connection per stateDir, cached for the lifetime of the MCP
// process. bun:sqlite Database is cheap to keep open; opening is what costs.
// Cached connections also allow prepared-statement reuse later if needed.

const dbCache = new Map<string, Database>();

// Prepared-statement cache per Database. bun:sqlite's prepare() compiles SQL
// to bytecode each call, which is cheap but not free. For hot-path queries
// (heartbeat writeSession every 30s × N MCPs, writeAllOffsets every 1500ms)
// the per-call recompile adds measurable overhead. WeakMap auto-evicts when
// the Database is GC'd, so no manual cleanup needed.
const stmtCache = new WeakMap<Database, Map<string, ReturnType<Database["prepare"]>>>();

function prep(db: Database, sql: string): ReturnType<Database["prepare"]> {
  let dbStmts = stmtCache.get(db);
  if (!dbStmts) {
    dbStmts = new Map();
    stmtCache.set(db, dbStmts);
  }
  let stmt = dbStmts.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    dbStmts.set(sql, stmt);
  }
  return stmt;
}

/**
 * Test/diagnostic: close + uncache the SQLite connection for a stateDir.
 * Production code shouldn't need this - process exit releases the lock - but
 * tests that `rmSync` the stateDir between cases need to release the file
 * lock first or they'll hit EBUSY on Windows.
 */
export function closeAgentChannelDb(stateDir: string): void {
  const db = dbCache.get(stateDir);
  if (db) {
    // Checkpoint + truncate WAL into the main DB file before close so the
    // .db-wal and .db-shm files are reclaimable. On Windows, WAL/SHM files
    // can otherwise remain locked briefly after close(), tripping EBUSY in
    // rmSync teardown.
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // ignore - DB may already be closing or in a bad state
    }
    db.close();
    dbCache.delete(stateDir);
  }
  // Belt-and-suspenders: best-effort unlink of WAL/SHM/journal artifacts in
  // case the OS hasn't released them yet. The main .db file is left alone -
  // rmSync (or production code) handles it.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      unlinkSync(join(stateDir, AGENT_CHANNEL_DB_FILE + suffix));
    } catch {
      // file may not exist or be momentarily locked - ignore
    }
  }
}

function getDb(stateDir: string): Database {
  const cached = dbCache.get(stateDir);
  if (cached) return cached;
  ensureDir(stateDir);
  // Reclaim pre-0.30.35 atomic-write debris once per process per stateDir
  // (WI 603dc765). Off the cached fast-path so it never touches the hot
  // loop. Best-effort + age-gated - see sweepStaleTmpArtifacts.
  sweepStaleTmpArtifacts(stateDir);
  // Path resolution: defaults to `<stateDir>/agent_channel.db` for production.
  // Tests set ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY=":memory:" because
  // bun:sqlite on Windows holds file handles for the .db (and WAL/SHM) for an
  // indefinite window after Database.close() returns - this trips EBUSY in
  // rmSync test teardown. `:memory:` databases live in process memory and
  // have no file to lock; per-stateDir cache key still isolates each test.
  //
  // The env var name explicitly ends in _TEST_ONLY so production users can't
  // misread it as a perf setting. If somehow set in production anyway, we
  // log a loud stderr warning - all session state would silently vanish on
  // restart otherwise.
  const useInMemory =
    process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY === ":memory:";
  if (useInMemory && process.env.NODE_ENV === "production") {
    process.stderr.write(
      "[orchestrator] WARNING: ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY=" +
        ":memory: is a TEST-ONLY setting. In production this loses all " +
        "session state on every MCP restart. Unset to use file-backed " +
        "storage.\n",
    );
  }
  const dbPath = useInMemory
    ? ":memory:"
    : join(stateDir, AGENT_CHANNEL_DB_FILE);
  const db = new Database(dbPath);
  // WAL = multiple readers + atomic writers, no shared-lock contention.
  // synchronous=NORMAL gives best performance with WAL (sync'd at commit
  // boundaries + checkpoints, not every write). Acceptable durability
  // tradeoff: heartbeat data lost on crash is re-emitted within 30s; offsets
  // lost just means filewatcher re-reads from last persisted byte. PRAGMA is
  // a no-op on :memory: DBs but harmless to set unconditionally.
  if (!useInMemory) {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      id8 TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      current_task TEXT,
      kind TEXT,
      warm_context TEXT,
      liveness_state TEXT,
      liveness_ts TEXT,
      liveness_expires_at TEXT,
      hot_path_status TEXT,
      keep_clean INTEGER
    );
    CREATE TABLE IF NOT EXISTS global_pause (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active INTEGER NOT NULL,
      since TEXT,
      set_by_session TEXT
    );
    CREATE TABLE IF NOT EXISTS sa_pause (
      sa_session_id TEXT PRIMARY KEY,
      since TEXT NOT NULL,
      set_by_session TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS offsets (
      receiver_id8 TEXT NOT NULL,
      jsonl_path TEXT NOT NULL,
      offset_bytes INTEGER NOT NULL,
      PRIMARY KEY (receiver_id8, jsonl_path)
    );
    CREATE TABLE IF NOT EXISTS system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      from_session TEXT NOT NULL,
      to_session TEXT NOT NULL,
      ts TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS system_events_id_idx ON system_events(id);
  `);
  // PA-coherence primitive: additive columns on PRE-EXISTING DBs (the CREATE
  // above only adds them to fresh DBs). Idempotent - a no-op once present.
  ensureColumns(db, "sessions", {
    warm_context: "TEXT",
    liveness_state: "TEXT",
    liveness_ts: "TEXT",
    liveness_expires_at: "TEXT",
    hot_path_status: "TEXT",
    keep_clean: "INTEGER",
  });
  dbCache.set(stateDir, db);
  return db;
}

/** Idempotently add missing columns to `table`. SQLite's ALTER TABLE ADD COLUMN
 *  errors if the column exists, so guard on PRAGMA table_info. Additive only -
 *  never drops or retypes. Exported for the schema-migration test. */
export function ensureColumns(
  db: Database,
  table: string,
  cols: Record<string, string>,
): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  for (const [col, decl] of Object.entries(cols)) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl};`);
    }
  }
}

// === sessions ===

interface SessionRow {
  session_id: string;
  id8: string;
  role: string;
  name: string;
  started_at: string;
  last_heartbeat_at: string;
  current_task: string | null;
  kind: string | null;
  warm_context: string | null;
  liveness_state: string | null;
  liveness_ts: string | null;
  liveness_expires_at: string | null;
  hot_path_status: string | null;
  keep_clean: number | null;
}

function rowToEntry(r: SessionRow): SessionEntry {
  const entry: SessionEntry = {
    session_id: r.session_id,
    id8: r.id8,
    role: r.role as "prime" | "subordinate",
    name: r.name,
    started_at: r.started_at,
    last_heartbeat_at: r.last_heartbeat_at,
  };
  // Preserve JSON-roundtrip semantics: omit fields that were absent in input
  // (stored as NULL in DB). Tests rely on this for toEqual() comparisons,
  // and callers that don't write current_task/kind shouldn't see them
  // surface as explicit nulls in the returned shape.
  if (r.current_task !== null) entry.current_task = r.current_task;
  if (r.kind !== null) entry.kind = r.kind as SessionKind;
  // PA-coherence columns (omit-when-NULL, same roundtrip discipline).
  if (r.warm_context !== null) {
    try {
      const parsed = JSON.parse(r.warm_context);
      if (Array.isArray(parsed)) entry.warm_context = parsed as string[];
    } catch {
      // Corrupt JSON -> treat as unknown, don't surface a bad value.
    }
  }
  if (r.liveness_state !== null) entry.liveness_state = r.liveness_state as LivenessState;
  if (r.liveness_ts !== null) entry.liveness_ts = r.liveness_ts;
  if (r.liveness_expires_at !== null) entry.liveness_expires_at = r.liveness_expires_at;
  if (r.hot_path_status !== null) entry.hot_path_status = r.hot_path_status;
  if (r.keep_clean !== null) entry.keep_clean = r.keep_clean !== 0;
  return entry;
}

function migrateSessionsLegacy(stateDir: string, db: Database): void {
  const legacyPath = join(stateDir, SESSIONS_FILE);
  if (!existsSync(legacyPath)) return;

  let legacy: SessionEntry[] = [];
  try {
    const data = JSON.parse(readFileSync(legacyPath, "utf8"));
    legacy = Array.isArray(data) ? data : (data?.sessions ?? []);
  } catch {
    // Corrupt legacy - delete and skip migration.
    try {
      unlinkSync(legacyPath);
    } catch {
      // race-tolerant: another MCP may have raced us
    }
    return;
  }

  if (legacy.length > 0) {
    // UPSERT with freshness guard: INSERT new rows; for existing rows, UPDATE
    // only if the legacy entry's heartbeat is fresher than what's in the DB.
    // This handles the mixed-version upgrade window: an old-version MCP keeps
    // writing legacy sessions.json after the first migration deleted it, and
    // a plain INSERT OR IGNORE would silently discard those fresh heartbeats
    // until the old MCP eventually upgrades - long enough for the reaper to
    // mistakenly treat the old MCP as departed. Now its fresh heartbeats
    // propagate into the DB on every readSessions call. (code-reviewer finding
    // (b), 2026-05-12.)
    const stmt = db.prepare(`
      INSERT INTO sessions
        (session_id, id8, role, name, started_at, last_heartbeat_at, current_task, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        id8 = excluded.id8,
        role = excluded.role,
        name = excluded.name,
        started_at = excluded.started_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        current_task = excluded.current_task,
        kind = excluded.kind
      WHERE excluded.last_heartbeat_at > sessions.last_heartbeat_at
    `);
    db.transaction(() => {
      for (const e of legacy) {
        if (!e?.session_id) continue;
        stmt.run(
          e.session_id,
          e.id8 ?? "",
          e.role ?? "subordinate",
          e.name ?? "",
          e.started_at ?? new Date().toISOString(),
          e.last_heartbeat_at ?? new Date().toISOString(),
          e.current_task ?? null,
          e.kind ?? null,
        );
      }
    })();
  }

  try {
    unlinkSync(legacyPath);
  } catch {
    // race-tolerant
  }
}

export function readSessions(stateDir: string): SessionEntry[] {
  const db = getDb(stateDir);
  migrateSessionsLegacy(stateDir, db);
  const rows = prep(
    db,
    `SELECT session_id, id8, role, name, started_at, last_heartbeat_at,
            current_task, kind, warm_context, liveness_state, liveness_ts,
            liveness_expires_at, hot_path_status, keep_clean
     FROM sessions`,
  ).all() as SessionRow[];
  return rows.map(rowToEntry);
}

export function writeSession(stateDir: string, entry: SessionEntry): void {
  if (!entry?.session_id) return;
  const db = getDb(stateDir);
  // Atomic UPSERT that updates ONLY the base fields on conflict. Changed from
  // INSERT OR REPLACE (which rewrites the WHOLE row) so that a heartbeat - which
  // runs every 30s and carries only base fields - does NOT clobber the
  // PA-coherence columns (warm_context / liveness_* / hot_path_status /
  // keep_clean). Those are OBSERVER- or self-set via the dedicated setters
  // below; liveness_* in particular is written by a PEER about this subject and
  // could never survive if the subject's own heartbeat REPLACE'd the row.
  // Race-free by SQLite/WAL semantics (BEGIN IMMEDIATE serializes writers).
  prep(
    db,
    `INSERT INTO sessions
       (session_id, id8, role, name, started_at, last_heartbeat_at, current_task, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       id8 = excluded.id8,
       role = excluded.role,
       name = excluded.name,
       started_at = excluded.started_at,
       last_heartbeat_at = excluded.last_heartbeat_at,
       current_task = excluded.current_task,
       kind = excluded.kind`,
  ).run(
    entry.session_id,
    entry.id8,
    entry.role,
    entry.name,
    entry.started_at,
    entry.last_heartbeat_at,
    entry.current_task ?? null,
    entry.kind ?? null,
  );
}

// === PA-coherence setters (dedicated per-column; never via writeSession) ===
// Each is an UPDATE on an existing row - a no-op if the session isn't registered
// yet (the row is created by writeSession on the first heartbeat). Additive and
// idempotent; safe to call from any observer or the subject itself.

/** Set/replace a session's warm_context (JSON array of subsystem/file/WI tags). */
export function setWarmContext(stateDir: string, session_id: string, tags: string[]): void {
  const db = getDb(stateDir);
  prep(db, `UPDATE sessions SET warm_context = ? WHERE session_id = ?`).run(
    JSON.stringify(tags),
    session_id,
  );
}

/** Set a session's self-declared hot-path status
 *  (`driving` | `holding-for-<X>` | `idle-available` | `parked`). */
export function setHotPathStatus(stateDir: string, session_id: string, status: string): void {
  const db = getDb(stateDir);
  prep(db, `UPDATE sessions SET hot_path_status = ? WHERE session_id = ?`).run(
    status,
    session_id,
  );
}

/** Set a session's self-declared keep-clean (pollution) flag. */
export function setKeepClean(stateDir: string, session_id: string, keep: boolean): void {
  const db = getDb(stateDir);
  prep(db, `UPDATE sessions SET keep_clean = ? WHERE session_id = ?`).run(
    keep ? 1 : 0,
    session_id,
  );
}

/** Record a fleet-liveness observation about `session_id`, FRESHEST-observation
 *  wins: the write applies only if `observedAt` is at least as new as the
 *  stored `liveness_ts` (or none is stored). Any peer may write - there is NO
 *  single designated observer (that would be a SPOF killing the peer-redundancy
 *  that makes egress/ingress detection work). A `_suspect` state carries a TTL
 *  (`ttlSeconds` -> `liveness_expires_at`); `healthy` clears it. */
export function setSessionLiveness(
  stateDir: string,
  session_id: string,
  opts: { state: LivenessState; observedAt: string; ttlSeconds?: number },
): void {
  const db = getDb(stateDir);
  const expiresAt =
    opts.state !== "healthy" && opts.ttlSeconds
      ? new Date(new Date(opts.observedAt).getTime() + opts.ttlSeconds * 1000).toISOString()
      : null;
  // Freshest-wins guard in SQL: update only when the incoming observation is not
  // older than the stored one (NULL stored -> always accept).
  prep(
    db,
    `UPDATE sessions
       SET liveness_state = ?, liveness_ts = ?, liveness_expires_at = ?
     WHERE session_id = ?
       AND (liveness_ts IS NULL OR liveness_ts <= ?)`,
  ).run(opts.state, opts.observedAt, expiresAt, session_id, opts.observedAt);
}

export function removeSession(stateDir: string, session_id: string): void {
  const db = getDb(stateDir);
  prep(db, `DELETE FROM sessions WHERE session_id = ?`).run(session_id);
}

// === override_state (global_pause + sa_pause tables) ===

function migrateOverrideStateLegacy(stateDir: string, db: Database): void {
  const legacyPath = join(stateDir, STATE_FILE);
  if (!existsSync(legacyPath)) return;

  let legacy: Partial<OverrideState> | null = null;
  try {
    legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    try {
      unlinkSync(legacyPath);
    } catch {
      // race-tolerant
    }
    return;
  }

  if (legacy) {
    db.transaction(() => {
      if (legacy.pa_global_pause) {
        db.prepare(`
          INSERT OR IGNORE INTO global_pause (id, active, since, set_by_session)
          VALUES (1, ?, ?, ?)
        `).run(
          legacy.pa_global_pause.active ? 1 : 0,
          legacy.pa_global_pause.since,
          legacy.pa_global_pause.set_by_session,
        );
      }
      if (legacy.sa_pauses) {
        const saStmt = db.prepare(`
          INSERT OR IGNORE INTO sa_pause (sa_session_id, since, set_by_session)
          VALUES (?, ?, ?)
        `);
        for (const [sa, info] of Object.entries(legacy.sa_pauses)) {
          if (info?.since && info?.set_by_session) {
            saStmt.run(sa, info.since, info.set_by_session);
          }
        }
      }
    })();
  }

  try {
    unlinkSync(legacyPath);
  } catch {
    // race-tolerant
  }
}

export function readOverrideState(stateDir: string): OverrideState {
  const db = getDb(stateDir);
  migrateOverrideStateLegacy(stateDir, db);

  const gp = prep(
    db,
    `SELECT active, since, set_by_session FROM global_pause WHERE id = 1`,
  ).get() as
    | { active: number; since: string | null; set_by_session: string | null }
    | undefined;

  const sas = prep(
    db,
    `SELECT sa_session_id, since, set_by_session FROM sa_pause`,
  ).all() as Array<{
    sa_session_id: string;
    since: string;
    set_by_session: string;
  }>;

  return {
    pa_global_pause: gp
      ? {
          active: gp.active === 1,
          since: gp.since,
          set_by_session: gp.set_by_session,
        }
      : { active: false, since: null, set_by_session: null },
    sa_pauses: Object.fromEntries(
      sas.map((s) => [
        s.sa_session_id,
        { since: s.since, set_by_session: s.set_by_session },
      ]),
    ),
  };
}

export function setSAPause(
  stateDir: string,
  sa_session_id: string,
  set_by: string,
): void {
  const db = getDb(stateDir);
  prep(
    db,
    `INSERT OR REPLACE INTO sa_pause (sa_session_id, since, set_by_session)
     VALUES (?, ?, ?)`,
  ).run(sa_session_id, new Date().toISOString(), set_by);
}

export function clearSAPause(stateDir: string, sa_session_id: string): void {
  const db = getDb(stateDir);
  prep(db, `DELETE FROM sa_pause WHERE sa_session_id = ?`).run(sa_session_id);
}

export function setGlobalPause(stateDir: string, pa_session_id: string): void {
  const db = getDb(stateDir);
  prep(
    db,
    `INSERT OR REPLACE INTO global_pause (id, active, since, set_by_session)
     VALUES (1, 1, ?, ?)`,
  ).run(new Date().toISOString(), pa_session_id);
}

export function clearGlobalPause(stateDir: string): void {
  const db = getDb(stateDir);
  // Reset the singleton row to inactive rather than delete it. readOverrideState
  // handles missing row -> inactive, so DELETE would also work; INSERT OR REPLACE
  // is just more explicit about intent.
  prep(
    db,
    `INSERT OR REPLACE INTO global_pause (id, active, since, set_by_session)
     VALUES (1, 0, NULL, NULL)`,
  ).run();
}

// === offsets (per-(receiver_id8, jsonl_path) byte offsets) ===
//
// Each MCP filewatcher tracks per-jsonl-path byte offsets so it knows where
// to resume reading on the next tick. Pre-0.30.35 these were stored per-
// receiver as `offsets-<id8>.json`. The per-receiver file isolation was
// race-free at the file level, but the atomicWrite retry pattern under
// EBUSY/AV/OneDrive locks left dozens of orphan `*.tmp.*` files in the
// state dir. SQLite eliminates the orphan class while keeping per-receiver
// isolation (PRIMARY KEY includes receiver_id8).

function migrateOffsetsLegacy(
  stateDir: string,
  db: Database,
  receiverId8: string,
): void {
  const legacyPath = join(stateDir, `offsets-${receiverId8}.json`);
  if (!existsSync(legacyPath)) return;

  let legacy: Record<string, number> | null = null;
  try {
    legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    try {
      unlinkSync(legacyPath);
    } catch {
      // race-tolerant
    }
    return;
  }

  if (legacy && typeof legacy === "object") {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO offsets (receiver_id8, jsonl_path, offset_bytes)
      VALUES (?, ?, ?)
    `);
    db.transaction(() => {
      for (const [jsonlPath, offset] of Object.entries(legacy!)) {
        if (typeof offset === "number" && Number.isFinite(offset)) {
          stmt.run(receiverId8, jsonlPath, offset);
        }
      }
    })();
  }

  try {
    unlinkSync(legacyPath);
  } catch {
    // race-tolerant
  }
}

export function readOffsets(
  stateDir: string,
  receiverId8: string,
): Record<string, number> {
  const db = getDb(stateDir);
  migrateOffsetsLegacy(stateDir, db, receiverId8);
  const rows = prep(
    db,
    `SELECT jsonl_path, offset_bytes FROM offsets WHERE receiver_id8 = ?`,
  ).all(receiverId8) as Array<{ jsonl_path: string; offset_bytes: number }>;
  return Object.fromEntries(rows.map((r) => [r.jsonl_path, r.offset_bytes]));
}

/**
 * Replace the entire offsets map for this receiver. Atomic: wrapped in a
 * SQLite transaction so partial writes are not visible to concurrent readers.
 *
 * Semantics match the prior file-based behavior: input map IS the new state
 * for this receiver. Entries not in the input are deleted; entries in the
 * input replace any prior values for matching jsonl_path. This is the hot
 * path - called every filewatcher tick (~1500ms) by every MCP for its own
 * receiver_id8. SQLite WAL handles N concurrent MCPs comfortably.
 */
export function writeAllOffsets(
  stateDir: string,
  receiverId8: string,
  offsets: Record<string, number>,
): void {
  const db = getDb(stateDir);
  const keys = Object.keys(offsets);
  db.transaction(() => {
    if (keys.length === 0) {
      // Empty input map clears all offsets for this receiver (matches the
      // prior `writeFileSync(path, "{}")` semantics).
      prep(db, `DELETE FROM offsets WHERE receiver_id8 = ?`).run(receiverId8);
      return;
    }
    // Delete any rows for this receiver that aren't in the new map. Uses
    // json_each() instead of dynamic IN(?, ?, ...) so the SQL is static and
    // the prepared statement is cached + reused across calls regardless of
    // map size. (code-reviewer finding (d), 2026-05-12.)
    prep(
      db,
      `DELETE FROM offsets WHERE receiver_id8 = ? AND jsonl_path NOT IN (SELECT value FROM json_each(?))`,
    ).run(receiverId8, JSON.stringify(keys));
    // Upsert each entry in the new map. Statement is cached across iterations
    // AND across calls via prep().
    const upsert = prep(
      db,
      `INSERT OR REPLACE INTO offsets (receiver_id8, jsonl_path, offset_bytes)
       VALUES (?, ?, ?)`,
    );
    for (const [jsonlPath, offset] of Object.entries(offsets)) {
      upsert.run(receiverId8, jsonlPath, offset);
    }
  })();
}

/** @deprecated Use writeAllOffsets to batch per-tick. Kept for callers
 *  outside the filewatcher hot loop. */
export function writeOffset(
  stateDir: string,
  receiverId8: string,
  jsonlPath: string,
  offset: number,
): void {
  const db = getDb(stateDir);
  prep(
    db,
    `INSERT OR REPLACE INTO offsets (receiver_id8, jsonl_path, offset_bytes)
     VALUES (?, ?, ?)`,
  ).run(receiverId8, jsonlPath, offset);
}

// === system_events (cross-MCP event bus, replaces legacy .jsonl) ===
//
// 0.30.36 (WI 3262525b): the previous file-based event bus
// (`system_events.jsonl` with byte-offset bookkeeping) moved into SQLite
// alongside sessions/state/offsets. Each event is a row with auto-increment
// id; receivers track `lastSeenId` instead of byte offsets. Static SQL,
// indexable lookups, no partial-line-read defensive parsing.
//
// Events are emitted cross-process (e.g. SA's MCP writes a permission_request
// addressed to PA; PA's filewatcher reads it on next tick). Currently no
// auto-reaping - rows accumulate. Add later via DELETE WHERE id < min(all
// active receivers' last_seen_id) when the table grows enough to matter.

export interface SystemEvent {
  event_type: string;
  from_session: string;
  to_session: string;
  ts: string;
  /** Event-type-specific payload (any additional fields). */
  [key: string]: unknown;
}

interface SystemEventRow {
  id: number;
  event_type: string;
  from_session: string;
  to_session: string;
  ts: string;
  payload: string;
}

function rowToSystemEvent(r: SystemEventRow): SystemEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // Skip - corrupt payload, fall back to no extra fields
  }
  return {
    event_type: r.event_type,
    from_session: r.from_session,
    to_session: r.to_session,
    ts: r.ts,
    ...payload,
  };
}

function migrateSystemEventsLegacy(stateDir: string, db: Database): void {
  const legacyPath = join(stateDir, "system_events.jsonl");
  if (!existsSync(legacyPath)) return;

  let lines: string[] = [];
  try {
    lines = readFileSync(legacyPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
  } catch {
    try {
      unlinkSync(legacyPath);
    } catch {
      // race-tolerant
    }
    return;
  }

  if (lines.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO system_events (event_type, from_session, to_session, ts, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (
            !ev ||
            typeof ev.event_type !== "string" ||
            typeof ev.from_session !== "string" ||
            typeof ev.to_session !== "string"
          ) {
            continue;
          }
          const ts = typeof ev.ts === "string" ? ev.ts : new Date().toISOString();
          // Pull payload out (everything except the 4 standard fields)
          const { event_type, from_session, to_session, ts: _ts, ...payload } = ev;
          stmt.run(
            event_type,
            from_session,
            to_session,
            ts,
            JSON.stringify(payload),
          );
        } catch {
          // Skip malformed lines - don't break migration on a single bad entry
        }
      }
    })();
  }

  try {
    unlinkSync(legacyPath);
  } catch {
    // race-tolerant - another MCP may have raced us
  }
}

/**
 * Append a single cross-MCP event. Returns the assigned id (useful for
 * tests / diagnostics; production callers typically ignore it).
 */
export function appendSystemEvent(
  stateDir: string,
  event: SystemEvent,
): number {
  const db = getDb(stateDir);
  migrateSystemEventsLegacy(stateDir, db);
  const { event_type, from_session, to_session, ts, ...payload } = event;
  const info = prep(
    db,
    `INSERT INTO system_events (event_type, from_session, to_session, ts, payload)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    event_type,
    from_session,
    to_session,
    ts,
    JSON.stringify(payload),
  );
  return Number(info.lastInsertRowid);
}

/**
 * Read new events with id > `lastSeenId`. Returns the parsed events plus the
 * new max-id so the caller can persist it. Stateless from the DB's
 * perspective - per-receiver "last seen" tracking is the caller's job
 * (in-memory in AgentChannel, same pattern as the pre-0.30.36 byte offset).
 *
 * Replay-on-restart: callers store `lastSeenId` in memory only, so on MCP
 * restart they begin at 0 and re-read everything in the table. That mirrors
 * the pre-0.30.36 behavior where `systemEventsOffset` reset to 0 each tick.
 */
export function readNewSystemEvents(
  stateDir: string,
  lastSeenId: number,
): { events: SystemEvent[]; newSeenId: number } {
  const db = getDb(stateDir);
  migrateSystemEventsLegacy(stateDir, db);
  const rows = prep(
    db,
    `SELECT id, event_type, from_session, to_session, ts, payload
       FROM system_events
       WHERE id > ?
       ORDER BY id`,
  ).all(lastSeenId) as SystemEventRow[];
  const events = rows.map(rowToSystemEvent);
  const newSeenId = rows.length > 0 ? rows[rows.length - 1].id : lastSeenId;
  return { events, newSeenId };
}

/**
 * Test/diagnostic: wipe the system_events table. Don't call from production
 * code - permission_request flows in flight would be lost.
 */
export function clearSystemEvents(stateDir: string): void {
  const db = getDb(stateDir);
  prep(db, `DELETE FROM system_events`).run();
}
