// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = import.meta.require;

// ../orchestrator/mcp/db/schema.ts
function getMigrations(dbType = "project") {
  if (dbType === "global") {
    return [...MIGRATIONS, ...GLOBAL_MIGRATIONS];
  }
  return [...MIGRATIONS];
}
function applyMigrations(db, dbType = "project") {
  db.run(`
    CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
    );
  `);
  const migrations = getMigrations(dbType);
  const applied = new Set(db.query("SELECT version FROM migrations").all().map((r) => r.version));
  for (const migration of migrations) {
    if (applied.has(migration.version))
      continue;
    db.run("BEGIN IMMEDIATE");
    try {
      if (db.query("SELECT 1 FROM migrations WHERE version = ?").get(migration.version)) {
        db.run("COMMIT");
        continue;
      }
      if (migration.customApply) {
        migration.customApply(db);
      } else {
        db.exec(migration.sql);
      }
      db.run("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)", [migration.version, migration.name, new Date().toISOString()]);
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${err}`);
    }
  }
}
var MIGRATIONS, GLOBAL_MIGRATIONS;
var init_schema = __esm(() => {
  MIGRATIONS = [
    {
      version: 1,
      name: "create_notes",
      sql: `
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    context TEXT,
    keywords TEXT,
    tags TEXT,
    source TEXT,
    confidence TEXT DEFAULT 'medium',
    last_validated TEXT,
    resolved INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);
CREATE INDEX IF NOT EXISTS idx_notes_confidence ON notes(confidence);
CREATE INDEX IF NOT EXISTS idx_notes_resolved ON notes(resolved);
`
    },
    {
      version: 2,
      name: "create_notes_fts",
      sql: `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    content, context, keywords,
    content='notes',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, content, context, keywords)
    VALUES (new.rowid, new.content, new.context, new.keywords);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, content, context, keywords)
    VALUES ('delete', old.rowid, old.content, old.context, old.keywords);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, content, context, keywords)
    VALUES ('delete', old.rowid, old.content, old.context, old.keywords);
    INSERT INTO notes_fts(rowid, content, context, keywords)
    VALUES (new.rowid, new.content, new.context, new.keywords);
END;
`
    },
    {
      version: 3,
      name: "create_links",
      sql: `
CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL,
    strength TEXT DEFAULT 'moderate',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_note_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_note_id);
`
    },
    {
      version: 4,
      name: "create_migrations_table",
      sql: `
CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
`
    },
    {
      version: 5,
      name: "add_work_item_fields",
      sql: `
ALTER TABLE notes ADD COLUMN status TEXT;
ALTER TABLE notes ADD COLUMN priority TEXT;
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
CREATE INDEX IF NOT EXISTS idx_notes_priority ON notes(priority);
`
    },
    {
      version: 6,
      name: "add_due_date",
      sql: `
ALTER TABLE notes ADD COLUMN due_date TEXT;
CREATE INDEX IF NOT EXISTS idx_notes_due_date ON notes(due_date);
`
    },
    {
      version: 7,
      name: "create_embeddings",
      sql: `
CREATE TABLE IF NOT EXISTS embeddings (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  model TEXT NOT NULL,
  embedded_at TEXT NOT NULL
);
`
    },
    {
      version: 8,
      name: "add_activation_tracking",
      sql: `
ALTER TABLE notes ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE notes ADD COLUMN last_accessed_at TEXT;
`
    },
    {
      version: 9,
      name: "create_session_log",
      sql: `
CREATE TABLE IF NOT EXISTS session_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  surfaced_at TEXT NOT NULL,
  turn_number INTEGER,
  delivery_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_log_session ON session_log(session_id);
CREATE INDEX IF NOT EXISTS idx_session_log_note ON session_log(note_id);
`
    },
    {
      version: 10,
      name: "create_session_registry",
      sql: `
CREATE TABLE IF NOT EXISTS session_registry (
  session_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  current_task TEXT,
  agent_model TEXT,
  notes_surfaced INTEGER DEFAULT 0,
  compaction_count INTEGER DEFAULT 0,
  concierge_agent_id TEXT
);
`
    },
    {
      version: 11,
      name: "add_signal_column",
      sql: `
CREATE TABLE IF NOT EXISTS _signal_migration_check (x);
DROP TABLE _signal_migration_check;
`,
      customApply: (db) => {
        const cols = db.query("PRAGMA table_info(notes)").all();
        if (!cols.some((c) => c.name === "signal")) {
          db.exec("ALTER TABLE notes ADD COLUMN signal REAL DEFAULT 0");
        }
        const hasAccessCount = cols.some((c) => c.name === "access_count");
        if (hasAccessCount) {
          db.exec("UPDATE notes SET signal = CAST(COALESCE(access_count, 0) AS REAL) WHERE signal = 0 OR signal IS NULL");
        }
      }
    },
    {
      version: 12,
      name: "drop_access_count",
      sql: `SELECT 1;`,
      customApply: (db) => {
        const cols = db.query("PRAGMA table_info(notes)").all();
        if (cols.some((c) => c.name === "access_count")) {
          db.exec("ALTER TABLE notes DROP COLUMN access_count");
        }
      }
    },
    {
      version: 13,
      name: "add_cross_session_tracking",
      sql: `SELECT 1;`,
      customApply: (db) => {
        const noteCols = db.query("PRAGMA table_info(notes)").all();
        if (!noteCols.some((c) => c.name === "source_session")) {
          db.exec("ALTER TABLE notes ADD COLUMN source_session TEXT");
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_source_session ON notes(source_session)");
        }
        const sessCols = db.query("PRAGMA table_info(session_registry)").all();
        if (!sessCols.some((c) => c.name === "last_briefing_at")) {
          db.exec("ALTER TABLE session_registry ADD COLUMN last_briefing_at TEXT");
        }
      }
    },
    {
      version: 14,
      name: "add_superseded_by",
      sql: `SELECT 1;`,
      customApply: (db) => {
        const cols = db.query("PRAGMA table_info(notes)").all();
        if (!cols.some((c) => c.name === "superseded_by")) {
          db.exec("ALTER TABLE notes ADD COLUMN superseded_by TEXT");
        }
        if (!cols.some((c) => c.name === "superseded_at")) {
          db.exec("ALTER TABLE notes ADD COLUMN superseded_at TEXT");
        }
        db.exec("CREATE INDEX IF NOT EXISTS idx_notes_superseded_by ON notes(superseded_by)");
      }
    },
    {
      version: 15,
      name: "add_note_revisions_and_link_unique",
      sql: `SELECT 1;`,
      customApply: (db) => {
        db.exec(`
        DELETE FROM links
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM links
          GROUP BY from_note_id, to_note_id, relationship
        )
      `);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique_edge ON links(from_note_id, to_note_id, relationship)`);
        db.exec(`
        CREATE TABLE IF NOT EXISTS note_revisions (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          context TEXT,
          tags TEXT,
          keywords TEXT,
          confidence TEXT,
          revised_at TEXT NOT NULL,
          revised_by_session TEXT
        )
      `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_note_revisions_note_id ON note_revisions(note_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_note_revisions_revised_at ON note_revisions(revised_at)`);
      }
    },
    {
      version: 16,
      name: "add_plugin_state",
      sql: `SELECT 1;`,
      customApply: (db) => {
        db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      }
    },
    {
      version: 17,
      name: "add_code_refs",
      sql: `SELECT 1;`,
      customApply: (db) => {
        const cols = db.query("PRAGMA table_info(notes)").all();
        if (!cols.some((c) => c.name === "code_refs")) {
          db.exec("ALTER TABLE notes ADD COLUMN code_refs TEXT");
        }
      }
    },
    {
      version: 18,
      name: "add_code_refs_to_note_revisions",
      sql: `SELECT 1;`,
      customApply: (db) => {
        const cols = db.query("PRAGMA table_info(note_revisions)").all();
        if (!cols.some((c) => c.name === "code_refs")) {
          db.exec("ALTER TABLE note_revisions ADD COLUMN code_refs TEXT");
        }
      }
    },
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
      }
    },
    {
      version: 20,
      name: "drop_session_messages",
      sql: `
DROP TABLE IF EXISTS session_message_reads;
DROP TABLE IF EXISTS session_messages;
`
    },
    {
      version: 21,
      name: "create_permission_audit",
      sql: `
CREATE TABLE IF NOT EXISTS permission_audit (
    request_id TEXT PRIMARY KEY,
    source_session TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    description TEXT,
    input_preview TEXT,
    verdict TEXT,
    pa_session TEXT,
    pa_reason TEXT,
    resolved_at TEXT,
    resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_permission_audit_source ON permission_audit(source_session);
CREATE INDEX IF NOT EXISTS idx_permission_audit_requested_at ON permission_audit(requested_at);
CREATE INDEX IF NOT EXISTS idx_permission_audit_verdict ON permission_audit(verdict);
`
    },
    {
      version: 22,
      name: "create_note_chunks",
      sql: `
CREATE TABLE IF NOT EXISTS note_chunks (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    vector BLOB NOT NULL,
    model TEXT NOT NULL,
    embedded_at TEXT NOT NULL,
    PRIMARY KEY (note_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_note_chunks_note ON note_chunks(note_id);
`
    },
    {
      version: 23,
      name: "add_current_task_at",
      sql: `SELECT 1;`,
      customApply: (db) => {
        const cols = db.query("PRAGMA table_info(session_registry)").all();
        if (cols.length === 0)
          return;
        if (!cols.some((c) => c.name === "current_task_at")) {
          db.exec("ALTER TABLE session_registry ADD COLUMN current_task_at TEXT");
        }
      }
    },
    {
      version: 24,
      name: "add_session_refs",
      sql: `SELECT 1;`,
      customApply: (db) => {
        const cols = db.query("PRAGMA table_info(session_registry)").all();
        if (cols.length === 0)
          return;
        if (!cols.some((c) => c.name === "refs")) {
          db.exec("ALTER TABLE session_registry ADD COLUMN refs TEXT");
        }
      }
    },
    {
      version: 25,
      name: "add_session_coherence_durable",
      sql: `SELECT 1;`,
      customApply: (db) => {
        const cols = db.query("PRAGMA table_info(session_registry)").all();
        if (cols.length === 0)
          return;
        if (!cols.some((c) => c.name === "warm_context")) {
          db.exec("ALTER TABLE session_registry ADD COLUMN warm_context TEXT");
        }
        if (!cols.some((c) => c.name === "hot_path_status")) {
          db.exec("ALTER TABLE session_registry ADD COLUMN hot_path_status TEXT");
        }
      }
    }
  ];
  GLOBAL_MIGRATIONS = [
    {
      version: 100,
      name: "create_user_model",
      sql: `
CREATE TABLE IF NOT EXISTS user_model (
    id TEXT PRIMARY KEY,
    dimension TEXT NOT NULL,
    observation TEXT NOT NULL,
    evidence TEXT,
    confidence TEXT DEFAULT 'medium',
    trajectory TEXT DEFAULT 'stable',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_model_dimension ON user_model(dimension);
CREATE INDEX IF NOT EXISTS idx_user_model_confidence ON user_model(confidence);
`
    },
    {
      version: 101,
      name: "create_autonomy_scores",
      sql: `
CREATE TABLE IF NOT EXISTS autonomy_scores (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    domain TEXT NOT NULL,
    score TEXT DEFAULT 'sparse',
    recipe_count INTEGER DEFAULT 0,
    gate_count INTEGER DEFAULT 0,
    anti_pattern_count INTEGER DEFAULT 0,
    last_assessed TEXT NOT NULL,
    UNIQUE(project, domain)
);
`
    }
  ];
});

// ../orchestrator/mcp/runtime/profile.ts
import { AsyncLocalStorage } from "async_hooks";
import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
function runtimeProfile(env = process.env) {
  const host = env.ORCHESTRATOR_HOST || "claude";
  const mode = env.ORCHESTRATOR_MODE || (host === "codex" ? "standalone" : "fleet");
  if (!(host === "claude" && mode === "fleet" || host === "codex" && mode === "standalone")) {
    throw new Error(`Unsupported orchestrator runtime: ${host}/${mode}`);
  }
  return { host, mode, standalone: host === "codex" };
}
function codexSessionId(value) {
  if (typeof value !== "string" || !/^(?:codex-)?[a-zA-Z0-9_-]{8,160}$/.test(value))
    return;
  return value.startsWith("codex-") ? value : `codex-${value}`;
}
function workingRoot() {
  return resolve(process.env.ORCHESTRATOR_WORKTREE_ROOT || process.cwd());
}
function knowledgeRoot() {
  if (!RUNTIME.standalone)
    return resolve(process.env.ORCHESTRATOR_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let root = process.env.ORCHESTRATOR_PROJECT_ROOT;
  const configPath = join(workingRoot(), ".orchestrator", "codex.json");
  if (!root && existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof config.knowledgeRoot === "string")
      root = resolve(workingRoot(), config.knowledgeRoot);
  }
  const result = resolve(root || workingRoot());
  if (/\.(?:claude|codex)[\\/]plugins[\\/]cache(?:[\\/]|$)/i.test(result)) {
    throw new Error("Refusing to store knowledge in a plugin cache. Configure ORCHESTRATOR_PROJECT_ROOT or .orchestrator/codex.json.");
  }
  return result;
}
var RUNTIME, requests, STANDALONE_INSTRUCTIONS;
var init_profile = __esm(() => {
  RUNTIME = runtimeProfile();
  requests = new AsyncLocalStorage;
  STANDALONE_INSTRUCTIONS = [
    "Orchestrator provides persistent project knowledge, work tracking and user preferences for this independent Codex task.",
    "Call briefing on startup or lost context; use lookup and check_similar alongside current source and documentation before substantive changes.",
    "Capture useful findings with note and code_refs. Amend or supersede existing knowledge when evidence changes. Use work-item tools to track delivery.",
    "Call save_progress at milestones and before finishing. Checkpoints and transient state are scoped to the current Codex task.",
    "Task identity is supplied by the host. Do not invent a session_id. system_status reports missing identity and hook delivery.",
    "Use retro explicitly for a maintenance pass; automatic retro is disabled in this host to avoid racing maintenance by other processes."
  ].join(`
`);
});

// ../orchestrator/mcp/db/connection.ts
var exports_connection = {};
__export(exports_connection, {
  getProjectDbPath: () => getProjectDbPath,
  getProjectDb: () => getProjectDb,
  getGlobalDbPath: () => getGlobalDbPath,
  getGlobalDb: () => getGlobalDb,
  closeAll: () => closeAll
});
import { Database } from "bun:sqlite";
import { existsSync as existsSync2, mkdirSync } from "fs";
import { dirname, join as join2 } from "path";
import { homedir } from "os";
function getGlobalDbPath() {
  if (process.env.ORCHESTRATOR_GLOBAL_DB)
    return process.env.ORCHESTRATOR_GLOBAL_DB;
  const newPath = join2(homedir(), ".claude", "orchestrator", "global.db");
  const legacyPath = join2(homedir(), ".orchestrator", "global.db");
  if (!RUNTIME.standalone && !existsSync2(newPath) && existsSync2(legacyPath)) {
    const newDir = dirname(newPath);
    if (!existsSync2(newDir)) {
      mkdirSync(newDir, { recursive: true });
    }
    const { copyFileSync } = __require("fs");
    copyFileSync(legacyPath, newPath);
    for (const suffix of ["-wal", "-shm"]) {
      const src = legacyPath + suffix;
      if (existsSync2(src)) {
        copyFileSync(src, newPath + suffix);
      }
    }
  }
  return newPath;
}
function getProjectDbPath() {
  if (RUNTIME.standalone)
    return join2(knowledgeRoot(), ".orchestrator", "project.db");
  const root = process.env.ORCHESTRATOR_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (root.includes(".claude/plugins/cache") || root.includes(".claude\\plugins\\cache")) {
    console.error(`[orchestrator] WARNING: Project DB path resolves to plugin cache (${root}). ` + `DB will be lost on plugin update! Set ORCHESTRATOR_PROJECT_ROOT or ensure CLAUDE_PROJECT_DIR is available.`);
  }
  return join2(root, ".orchestrator", "project.db");
}
function initDb(path, dbType) {
  const dir = dirname(path);
  if (!existsSync2(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 5000");
  const walDeadline = Date.now() + 5000;
  for (;; ) {
    try {
      db.run("PRAGMA journal_mode = WAL");
      break;
    } catch (error) {
      if (error.code !== "SQLITE_BUSY" || Date.now() >= walDeadline) {
        db.close();
        throw error;
      }
      Bun.sleepSync(25);
    }
  }
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  applyMigrations(db, dbType);
  return db;
}
function getGlobalDb() {
  if (!globalDb) {
    globalDb = initDb(getGlobalDbPath(), "global");
  }
  return globalDb;
}
function getProjectDb() {
  if (!projectDb) {
    projectDb = initDb(getProjectDbPath(), "project");
  }
  return projectDb;
}
function closeAll() {
  if (globalDb) {
    globalDb.close();
    globalDb = null;
  }
  if (projectDb) {
    projectDb.close();
    projectDb = null;
  }
}
var globalDb = null, projectDb = null;
var init_connection = __esm(() => {
  init_schema();
  init_profile();
});

// ../orchestrator/node_modules/uuid/dist/esm/native.js
import { randomUUID } from "crypto";
var native_default;
var init_native = __esm(() => {
  native_default = { randomUUID };
});

// ../orchestrator/node_modules/uuid/dist/esm/rng.js
import { randomFillSync } from "crypto";
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    randomFillSync(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}
var rnds8Pool, poolPtr;
var init_rng = __esm(() => {
  rnds8Pool = new Uint8Array(256);
  poolPtr = rnds8Pool.length;
});

// ../orchestrator/node_modules/uuid/dist/esm/stringify.js
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
var byteToHex;
var init_stringify = __esm(() => {
  byteToHex = [];
  for (let i = 0;i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
  }
});

// ../orchestrator/node_modules/uuid/dist/esm/v4.js
function v4(options, buf, offset) {
  if (native_default.randomUUID && !buf && !options) {
    return native_default.randomUUID();
  }
  options = options || {};
  const rnds = options.random ?? options.rng?.() ?? rng();
  if (rnds.length < 16) {
    throw new Error("Random bytes length must be >= 16");
  }
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    if (offset < 0 || offset + 16 > buf.length) {
      throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
    }
    for (let i = 0;i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return unsafeStringify(rnds);
}
var v4_default;
var init_v4 = __esm(() => {
  init_native();
  init_rng();
  init_stringify();
  v4_default = v4;
});

// ../orchestrator/node_modules/uuid/dist/esm/index.js
var init_esm = __esm(() => {
  init_v4();
});

// ../orchestrator/mcp/utils.ts
function generateId() {
  return v4_default();
}
function now() {
  return new Date().toISOString();
}
function truncate(text, maxLength = 100) {
  if (text.length <= maxLength)
    return text;
  return text.slice(0, maxLength - 3) + "...";
}
function parseCodeRefs(raw) {
  if (!raw)
    return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed.length > 0 ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}
var STOP_WORDS, SYNONYM_GROUPS, synonymLookup;
var init_utils = __esm(() => {
  init_esm();
  STOP_WORDS = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "is",
    "it",
    "as",
    "be",
    "was",
    "were",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "can",
    "need",
    "dare",
    "ought",
    "used",
    "not",
    "no",
    "nor",
    "so",
    "yet",
    "both",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "than",
    "too",
    "very",
    "just",
    "about",
    "above",
    "after",
    "again",
    "all",
    "also",
    "am",
    "any",
    "are",
    "because",
    "before",
    "below",
    "between",
    "during",
    "here",
    "how",
    "if",
    "into",
    "its",
    "let",
    "me",
    "my",
    "myself",
    "now",
    "off",
    "once",
    "only",
    "our",
    "out",
    "over",
    "own",
    "same",
    "she",
    "he",
    "her",
    "him",
    "his",
    "hers",
    "that",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "under",
    "until",
    "up",
    "we",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whom",
    "why",
    "you",
    "your",
    "yours",
    "i"
  ]);
  SYNONYM_GROUPS = [
    ["backup", "snapshot", "restore", "archive"],
    ["auth", "authentication", "login", "signin", "sign-in", "oidc", "kinde"],
    ["billing", "payment", "subscription", "stripe", "lemon"],
    ["deploy", "deployment", "ci", "cd", "pipeline", "release"],
    ["docker", "container", "image", "compose"],
    ["wsl", "linux", "distro", "ubuntu"],
    ["frontend", "ui", "component", "react", "tsx"],
    ["backend", "rust", "tauri", "handler", "command"],
    ["database", "sqlite", "db", "migration", "schema", "query"],
    ["player", "user", "session", "uuid"],
    ["event", "eventbus", "broadcast", "listener", "emit"],
    ["poller", "polling", "telemetry", "datapack", "rcon"],
    ["discord", "bot", "webhook", "guild"],
    ["cloud", "worker", "cloudflare", "wrangler", "d1", "r2"],
    ["test", "testing", "vitest", "spec", "assertion"],
    ["map", "tile", "region", "atlas", "chunk"],
    ["perf", "performance", "latency", "throughput", "instrument"],
    ["error", "bug", "fix", "issue", "broken"],
    ["config", "settings", "configuration", "preference"],
    ["encrypt", "encryption", "aes", "decrypt"],
    ["hibernate", "hibernation", "compress", "archive"],
    ["observer", "connect", "disconnect", "reconnect", "visibility"],
    ["http", "api", "endpoint", "route", "request"],
    ["store", "zustand", "state", "selector"]
  ];
  synonymLookup = new Map;
  for (const group of SYNONYM_GROUPS) {
    const groupSet = new Set(group);
    for (const word of group) {
      synonymLookup.set(word, groupSet);
    }
  }
});

// ../orchestrator/mcp/engine/agent_channel_state.ts
import {
  readFileSync as readFileSync2,
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  unlinkSync,
  readdirSync,
  statSync
} from "fs";
import { join as join3 } from "path";
import { Database as Database2 } from "bun:sqlite";
function ensureDir(dir) {
  if (!existsSync3(dir))
    mkdirSync2(dir, { recursive: true });
}
function sweepStaleTmpArtifacts(stateDir) {
  if (tmpSweptDirs.has(stateDir))
    return;
  tmpSweptDirs.add(stateDir);
  let entries;
  try {
    entries = readdirSync(stateDir);
  } catch {
    return;
  }
  const now2 = Date.now();
  for (const name of entries) {
    if (!name.includes(".tmp."))
      continue;
    const full = join3(stateDir, name);
    try {
      if (now2 - statSync(full).mtimeMs < TMP_SWEEP_MIN_AGE_MS)
        continue;
      unlinkSync(full);
    } catch {}
  }
}
function prep(db, sql) {
  let dbStmts = stmtCache.get(db);
  if (!dbStmts) {
    dbStmts = new Map;
    stmtCache.set(db, dbStmts);
  }
  let stmt = dbStmts.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    dbStmts.set(sql, stmt);
  }
  return stmt;
}
function getDb(stateDir) {
  const cached = dbCache.get(stateDir);
  if (cached)
    return cached;
  ensureDir(stateDir);
  sweepStaleTmpArtifacts(stateDir);
  const useInMemory = process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY === ":memory:";
  if (useInMemory && false) {}
  const dbPath = useInMemory ? ":memory:" : join3(stateDir, AGENT_CHANNEL_DB_FILE);
  const db = new Database2(dbPath);
  if (!useInMemory) {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
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
      refs TEXT,
      liveness_state TEXT,
      liveness_ts TEXT,
      liveness_expires_at TEXT,
      hot_path_status TEXT,
      keep_clean INTEGER,
      client_unreachable_since TEXT,
      instance TEXT
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
    CREATE TABLE IF NOT EXISTS alert_refractory (
      alert_kind TEXT NOT NULL,
      subject_session TEXT NOT NULL,
      last_emit_ms INTEGER NOT NULL,
      PRIMARY KEY (alert_kind, subject_session)
    );
    CREATE INDEX IF NOT EXISTS system_events_id_idx ON system_events(id);
  `);
  ensureColumns(db, "sessions", {
    warm_context: "TEXT",
    refs: "TEXT",
    liveness_state: "TEXT",
    liveness_ts: "TEXT",
    liveness_expires_at: "TEXT",
    hot_path_status: "TEXT",
    keep_clean: "INTEGER",
    client_unreachable_since: "TEXT",
    instance: "TEXT"
  });
  dbCache.set(stateDir, db);
  return db;
}
function ensureColumns(db, table, cols) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [col, decl] of Object.entries(cols)) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl};`);
    }
  }
}
function rowToEntry(r) {
  const entry = {
    session_id: r.session_id,
    id8: r.id8,
    role: r.role,
    name: r.name,
    started_at: r.started_at,
    last_heartbeat_at: r.last_heartbeat_at
  };
  if (r.current_task !== null)
    entry.current_task = r.current_task;
  if (r.kind !== null)
    entry.kind = r.kind;
  if (r.warm_context !== null) {
    try {
      const parsed = JSON.parse(r.warm_context);
      if (Array.isArray(parsed))
        entry.warm_context = parsed;
    } catch {}
  }
  if (r.refs !== null) {
    try {
      const parsed = JSON.parse(r.refs);
      if (Array.isArray(parsed))
        entry.refs = parsed;
    } catch {}
  }
  if (r.liveness_state !== null)
    entry.liveness_state = r.liveness_state;
  if (r.liveness_ts !== null)
    entry.liveness_ts = r.liveness_ts;
  if (r.liveness_expires_at !== null)
    entry.liveness_expires_at = r.liveness_expires_at;
  if (r.hot_path_status !== null)
    entry.hot_path_status = r.hot_path_status;
  if (r.keep_clean !== null)
    entry.keep_clean = r.keep_clean !== 0;
  if (r.client_unreachable_since !== null)
    entry.client_unreachable_since = r.client_unreachable_since;
  if (r.instance !== null)
    entry.instance = r.instance;
  return entry;
}
function migrateSessionsLegacy(stateDir, db) {
  const legacyPath = join3(stateDir, SESSIONS_FILE);
  if (!existsSync3(legacyPath))
    return;
  let legacy = [];
  try {
    const data = JSON.parse(readFileSync2(legacyPath, "utf8"));
    legacy = Array.isArray(data) ? data : data?.sessions ?? [];
  } catch {
    try {
      unlinkSync(legacyPath);
    } catch {}
    return;
  }
  if (legacy.length > 0) {
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
        if (!e?.session_id)
          continue;
        stmt.run(e.session_id, e.id8 ?? "", e.role ?? "subordinate", e.name ?? "", e.started_at ?? new Date().toISOString(), e.last_heartbeat_at ?? new Date().toISOString(), e.current_task ?? null, e.kind ?? null);
      }
    })();
  }
  try {
    unlinkSync(legacyPath);
  } catch {}
}
function readSessions(stateDir) {
  const db = getDb(stateDir);
  migrateSessionsLegacy(stateDir, db);
  const rows = prep(db, `SELECT session_id, id8, role, name, started_at, last_heartbeat_at,
            current_task, kind, warm_context, refs, liveness_state, liveness_ts,
            liveness_expires_at, hot_path_status, keep_clean, client_unreachable_since,
            instance
     FROM sessions`).all();
  return rows.map(rowToEntry);
}
var SESSIONS_FILE = "sessions.json", AGENT_CHANNEL_DB_FILE = "agent_channel.db", tmpSweptDirs, TMP_SWEEP_MIN_AGE_MS, dbCache, stmtCache;
var init_agent_channel_state = __esm(() => {
  tmpSweptDirs = new Set;
  TMP_SWEEP_MIN_AGE_MS = 5 * 60000;
  dbCache = new Map;
  stmtCache = new WeakMap;
});

// ../orchestrator/mcp/engine/live_sessions.ts
import { existsSync as existsSync4 } from "fs";
import { join as join4 } from "path";
function getAgentChannelStateDir() {
  const projectDir = process.env.ORCHESTRATOR_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const stateDir = join4(projectDir, ".orchestrator-state", "agent-channel");
  if (!existsSync4(stateDir))
    return null;
  const dbExists = existsSync4(join4(stateDir, "agent_channel.db"));
  const legacyExists = existsSync4(join4(stateDir, "sessions.json"));
  if (!dbExists && !legacyExists)
    return null;
  return stateDir;
}
function getLiveSessionIds() {
  const stateDir = getAgentChannelStateDir();
  if (!stateDir)
    return null;
  try {
    const entries = readSessions(stateDir);
    const nowMs = Date.now();
    const STALE_MS = 90000;
    const liveIds = new Set;
    for (const entry of entries) {
      if (!entry?.session_id || !entry?.last_heartbeat_at)
        continue;
      const lastHbMs = new Date(entry.last_heartbeat_at).getTime();
      if (Number.isFinite(lastHbMs) && nowMs - lastHbMs <= STALE_MS) {
        liveIds.add(entry.session_id);
      }
    }
    return liveIds;
  } catch {
    return null;
  }
}
function getLiveOtherSessionIds(sessionId) {
  const live = getLiveSessionIds();
  if (live === null)
    return null;
  const others = [];
  for (const id of live) {
    if (id !== sessionId)
      others.push(id);
  }
  return others;
}
var init_live_sessions = __esm(() => {
  init_agent_channel_state();
});

// ../orchestrator/mcp/engine/session_tracker.ts
class SessionTracker {
  db;
  liveOthersResolver;
  turnCounters = new Map;
  constructor(db, liveOthersResolver = getLiveOtherSessionIds) {
    this.db = db;
    this.liveOthersResolver = liveOthersResolver;
  }
  nextTurn(sessionId) {
    const current = this.turnCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this.turnCounters.set(sessionId, next);
    return next;
  }
  getCurrentTurn(sessionId) {
    return this.turnCounters.get(sessionId) ?? 0;
  }
  registerSession(sessionId, model) {
    const timestamp = now();
    this.db.run(`INSERT OR IGNORE INTO session_registry
       (session_id, started_at, last_active_at, agent_model, notes_surfaced, compaction_count, last_briefing_at)
       VALUES (?, ?, ?, ?, 0, 0, NULL)`, [sessionId, timestamp, timestamp, model ?? null]);
    this.db.run(`UPDATE session_registry SET last_active_at = ? WHERE session_id = ?`, [timestamp, sessionId]);
  }
  getSession(sessionId) {
    return this.db.query(`SELECT * FROM session_registry WHERE session_id = ?`).get(sessionId);
  }
  logSurfaced(sessionId, noteId, turnNumber, deliveryType) {
    const id = generateId();
    const timestamp = now();
    this.db.run(`INSERT INTO session_log (id, session_id, note_id, surfaced_at, turn_number, delivery_type)
       VALUES (?, ?, ?, ?, ?, ?)`, [id, sessionId, noteId, timestamp, turnNumber, deliveryType]);
    this.db.run(`UPDATE session_registry SET notes_surfaced = notes_surfaced + 1 WHERE session_id = ?`, [sessionId]);
  }
  getNotesSurfaced(sessionId) {
    const rows = this.db.query(`SELECT note_id, turn_number, delivery_type
         FROM session_log
         WHERE session_id = ?
         ORDER BY turn_number DESC`).all(sessionId);
    const result = new Map;
    for (const row of rows) {
      if (!result.has(row.note_id)) {
        result.set(row.note_id, {
          turn: row.turn_number,
          type: row.delivery_type
        });
      }
    }
    return result;
  }
  annotateResult(sessionId, noteId, currentTurn) {
    const selfRow = this.db.query(`SELECT turn_number FROM session_log
         WHERE session_id = ? AND note_id = ?
         ORDER BY turn_number DESC LIMIT 1`).get(sessionId, noteId);
    const already_sent = selfRow !== null;
    const sent_turns_ago = selfRow !== null ? currentTurn - selfRow.turn_number : null;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const crossRows = this.db.query(`SELECT session_id, turn_number FROM session_log
         WHERE note_id = ? AND session_id != ? AND surfaced_at > ?
         ORDER BY surfaced_at DESC`).all(noteId, sessionId, sevenDaysAgo);
    const sent_to_other_sessions = crossRows.map((r) => ({
      session_id: r.session_id,
      turn: r.turn_number
    }));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const hotRow = this.db.query(`SELECT COUNT(DISTINCT session_id) as cnt FROM session_log
         WHERE note_id = ? AND session_id != ? AND surfaced_at > ?`).get(noteId, sessionId, twoHoursAgo);
    const hot_across_sessions = hotRow?.cnt ?? 0;
    const noteRow = this.db.query(`SELECT signal FROM notes WHERE id = ?`).get(noteId);
    const activation_score = noteRow?.signal ?? 0;
    return {
      already_sent,
      sent_turns_ago,
      sent_to_other_sessions,
      hot_across_sessions,
      activation_score
    };
  }
  persistCoherence(sessionId, fields) {
    try {
      if (fields.warm_context !== undefined) {
        this.db.run(`UPDATE session_registry SET warm_context = ? WHERE session_id = ?`, [
          JSON.stringify(fields.warm_context),
          sessionId
        ]);
      }
      if (fields.hot_path_status !== undefined) {
        this.db.run(`UPDATE session_registry SET hot_path_status = ? WHERE session_id = ?`, [
          fields.hot_path_status,
          sessionId
        ]);
      }
    } catch {}
  }
  updateCurrentTask(sessionId, task, refs) {
    const ts = now();
    this.db.run(`UPDATE session_registry SET current_task = ?, current_task_at = ?, last_active_at = ? WHERE session_id = ?`, [task, ts, ts, sessionId]);
    if (refs !== undefined) {
      try {
        this.db.run(`UPDATE session_registry SET refs = ? WHERE session_id = ?`, [
          JSON.stringify(refs),
          sessionId
        ]);
      } catch {}
    }
    try {
      for (const key of [`task_turns_${sessionId}`, `task_acts_${sessionId}`]) {
        this.db.run(`INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '0', ?)`, [key, ts]);
      }
    } catch {}
  }
  getActiveSiblings(sessionId) {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.query(`SELECT session_id, current_task, last_active_at FROM session_registry
         WHERE session_id != ? AND last_active_at > ?
         ORDER BY last_active_at DESC
         LIMIT 40`).all(sessionId, twentyFourHoursAgo);
    const liveOthers = this.liveOthersResolver(sessionId);
    if (liveOthers === null)
      return rows;
    const liveSet = new Set(liveOthers);
    return rows.filter((r) => liveSet.has(r.session_id));
  }
  updateLastBriefing(sessionId, at) {
    const ts = at ?? now();
    this.db.run(`UPDATE session_registry SET last_briefing_at = ?, last_active_at = ? WHERE session_id = ?`, [ts, ts, sessionId]);
  }
  getCrossSessionUpdates(sessionId, upperBound) {
    const me = this.getSession(sessionId);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since = me?.last_briefing_at ?? twentyFourHoursAgo;
    const liveOthers = this.liveOthersResolver(sessionId);
    let activeSiblingClause;
    let activeSiblingParams;
    if (liveOthers !== null) {
      if (liveOthers.length === 0) {
        activeSiblingClause = "AND 0";
        activeSiblingParams = [];
      } else {
        const placeholders = liveOthers.map(() => "?").join(",");
        activeSiblingClause = `AND n.source_session IN (${placeholders})`;
        activeSiblingParams = liveOthers;
      }
    } else {
      activeSiblingClause = `AND EXISTS (
        SELECT 1 FROM session_registry sr
        WHERE sr.session_id = n.source_session
          AND sr.last_active_at > ?
      )`;
      activeSiblingParams = [twentyFourHoursAgo];
    }
    const activeCount = liveOthers !== null ? liveOthers.length : this.db.query(`SELECT COUNT(*) as cnt FROM session_registry
                 WHERE session_id != ? AND last_active_at > ?`).get(sessionId, twentyFourHoursAgo).cnt;
    const upperClause = upperBound ? "AND n.created_at <= ?" : "";
    const newNotesParams = upperBound ? [sessionId, since, upperBound, ...activeSiblingParams, sessionId] : [sessionId, since, ...activeSiblingParams, sessionId];
    const newNotesRows = this.db.query(`SELECT n.id, n.type, n.content, n.tags, n.created_at, n.source_session
         FROM notes n
         WHERE n.source_session IS NOT NULL
           AND n.source_session != ?
           AND n.created_at > ?
           ${upperClause}
           ${activeSiblingClause}
           AND n.id NOT IN (
             SELECT note_id FROM session_log WHERE session_id = ?
           )
         ORDER BY n.created_at DESC
         LIMIT 8`).all(...newNotesParams);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const readHotRows = this.db.query(`SELECT n.id, n.type, n.content, n.tags,
                COUNT(DISTINCT sl.session_id) as distinct_sessions,
                COUNT(*) as surfacings
         FROM session_log sl
         JOIN notes n ON n.id = sl.note_id
         WHERE sl.surfaced_at > ?
           AND sl.session_id != ?
         GROUP BY n.id
         HAVING distinct_sessions >= 2
         ORDER BY distinct_sessions DESC, surfacings DESC
         LIMIT 8`).all(twoHoursAgo, sessionId);
    const createHotRows = this.db.query(`SELECT n.id, n.type, n.content, n.tags, n.source_session
         FROM notes n
         WHERE n.source_session IS NOT NULL
           AND n.source_session != ?
           AND n.created_at > ?
           ${activeSiblingClause}
           AND n.id NOT IN (
             SELECT note_id FROM session_log WHERE session_id = ?
           )
         ORDER BY n.created_at DESC
         LIMIT 8`).all(sessionId, twoHoursAgo, ...activeSiblingParams, sessionId);
    const seen = new Set;
    const hotNotesRows = [];
    for (const r of readHotRows) {
      if (seen.has(r.id))
        continue;
      seen.add(r.id);
      hotNotesRows.push(r);
    }
    for (const r of createHotRows) {
      if (seen.has(r.id))
        continue;
      seen.add(r.id);
      hotNotesRows.push({
        id: r.id,
        type: r.type,
        content: r.content,
        tags: r.tags,
        distinct_sessions: 1,
        surfacings: 1
      });
    }
    const cappedHot = hotNotesRows.slice(0, 8);
    return {
      new_notes: newNotesRows,
      hot_notes: cappedHot,
      active_session_count: activeCount,
      since
    };
  }
  cleanup() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.run(`DELETE FROM session_log WHERE surfaced_at < ?`, [
      sevenDaysAgo
    ]);
    this.db.run(`DELETE FROM session_registry WHERE last_active_at < ?`, [
      sevenDaysAgo
    ]);
    this.db.run(`DELETE FROM plugin_state
       WHERE updated_at < ?
         AND (key LIKE 'wi_drift_%'
              OR key LIKE 'wi_touched_%'
              OR key LIKE 'code_refs_hint_%'
              OR key LIKE 'stop_%'
              OR key LIKE 'subagent_stop_%'
              OR key LIKE 'bridge_%'
              OR key LIKE 'orch_active_%'
              OR key LIKE 'preuse_warned_%'
              OR key LIKE 'struggle_%'
              OR key LIKE 'compacting_%')`, [sevenDaysAgo]);
  }
}
var init_session_tracker = __esm(() => {
  init_utils();
  init_live_sessions();
});
// ../orchestrator/mcp/engine/chunking.ts
var CHUNK_TARGET_CHARS = 1500, CHUNK_OVERLAP_CHARS = 200, MIN_SPLIT_CHARS;
var init_chunking = __esm(() => {
  MIN_SPLIT_CHARS = CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS;
});

// ../orchestrator/mcp/engine/embeddings.ts
var init_embeddings = __esm(() => {
  init_chunking();
});

// ../orchestrator/mcp/engine/signal.ts
function signalBoost(signal) {
  return 1 + 0.1 * Math.log(1 + Math.max(0, signal));
}
function confidenceMultiplier(confidence) {
  switch (confidence) {
    case "high":
      return 1.2;
    case "low":
      return 0.8;
    default:
      return 1;
  }
}
var init_signal = () => {};

// ../orchestrator/mcp/engine/deduplicator.ts
var init_deduplicator = __esm(() => {
  init_utils();
});

// ../orchestrator/mcp/engine/linker.ts
function findRelatedNotes(db, query, limit = 10, includeSuperseded = false, codeRefFilter) {
  const terms = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
  if (terms.length === 0)
    return [];
  const ftsQuery = terms.join(" OR ");
  const codeRefClause = codeRefFilter ? `AND n.code_refs LIKE ?` : ``;
  const escapedForLike = codeRefFilter ? JSON.stringify(codeRefFilter).slice(1, -1) : null;
  const codeRefLikeParam = escapedForLike !== null ? `%"${escapedForLike}"%` : null;
  try {
    const stage1K = Math.max(200, limit * 20);
    const prelim = db.query(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`).all(ftsQuery, stage1K);
    if (prelim.length === 0)
      return [];
    const rowidMarks = prelim.map(() => "?").join(",");
    const sql = `SELECT n.id, n.type, n.content, n.confidence, n.created_at, n.updated_at, n.source_session, n.superseded_by, n.keywords, n.tags, n.code_refs,
                COALESCE(n.signal, 0) AS note_signal,
                bm25(notes_fts, 1.0, 0.5, 2.0) AS rank
         FROM notes_fts
         JOIN notes n ON notes_fts.rowid = n.rowid
         WHERE notes_fts MATCH ?
           AND n.rowid IN (${rowidMarks})
           ${includeSuperseded ? "" : "AND n.superseded_by IS NULL"}
           ${codeRefClause}
         ORDER BY rank ASC
         LIMIT ?`;
    const rowids = prelim.map((r) => r.rowid);
    const params = codeRefLikeParam !== null ? [ftsQuery, ...rowids, codeRefLikeParam, limit * 2] : [ftsQuery, ...rowids, limit * 2];
    const rows = db.query(sql).all(...params);
    const rescored = rows.map((r) => ({
      row: r,
      finalScore: r.rank * signalBoost(r.note_signal) * confidenceMultiplier(r.confidence)
    }));
    rescored.sort((a, b) => a.finalScore - b.finalScore);
    const top = rescored.slice(0, limit).map((x) => x.row);
    return top.map((r) => ({
      id: r.id,
      type: r.type,
      content: r.content,
      confidence: r.confidence,
      created_at: r.created_at,
      updated_at: r.updated_at,
      source_session: r.source_session,
      superseded_by: r.superseded_by ?? null,
      keywords: r.keywords ? r.keywords.split(",").map((k) => k.trim()) : [],
      tags: r.tags ?? null,
      status: r.status ?? null,
      priority: r.priority ?? null,
      due_date: r.due_date ?? null,
      code_refs: parseCodeRefs(r.code_refs ?? null)
    }));
  } catch (err) {
    console.error(`[linker] findRelatedNotes FTS5 error - query="${ftsQuery}" original="${query}":`, err);
    return [];
  }
}
var init_linker = __esm(() => {
  init_utils();
  init_embeddings();
  init_signal();
  init_deduplicator();
});

// ../orchestrator/mcp/tools/hook_event.ts
function detectsRiskyHeredoc(command) {
  if (!command)
    return false;
  if (!HEREDOC_RE.test(command))
    return false;
  return BACKSLASH_ESCAPE_RE.test(command);
}
function detectsHedge(prompt) {
  if (!prompt)
    return false;
  return HEDGE_PATTERNS.some((re) => re.test(prompt));
}
function detectsScopeExpansion(prompt) {
  if (!prompt)
    return false;
  return SCOPE_EXPANSION_PATTERNS.some((re) => re.test(prompt));
}
function detectsRetrievalTrigger(prompt) {
  return detectsHedge(prompt) || detectsScopeExpansion(prompt);
}
function composeScopeRetrievalText(hits, reason = "hedge") {
  const head = reason === "expansion" ? `[orch] THIS PROMPT EXPANDS SCOPE ("can we also" / "what about" / "next let's"). ` + "You are entering ground this session has not worked, which is exactly where the " + "reflex is fresh code exploration and exactly where the KB, `git log` and `docs/` " + "most often already hold the answer. Note the risk here is NOT that the asker is " + "unsure - a confident request can still land on settled ground the repo has an " + "opinion about. Read before you explore, and verify the PREMISE of the request." : `[orch] YOUR PROMPT HEDGES ("i think" / "wasn't there" / "didn't we"). That is the ` + "signal that the ASKER is uncertain and the REPO probably is not. Do NOT answer this " + "from fresh code exploration alone - the KB, `git log` and `docs/` frequently already " + "hold the answer, sometimes to the exact question being asked. Verify the PREMISE too: " + "a hedged question often contains an assumption the repo will correct.";
  if (hits.length === 0) {
    return head + "\n  No stored notes matched this prompt's terms - so check `git log`, `docs/`, and " + "the code, and capture what you find.";
  }
  const lines = hits.map((h) => `  - [${h.id.slice(0, 8)}] ${h.type}: ${truncate(h.content, 170)}`).join(`
`);
  return head + `

  POSSIBLY RELEVANT PRIOR KNOWLEDGE (retrieved for you - \`lookup({id})\` for full bodies):
` + lines + `

  STALENESS CHECK: for each of these ask not only "have I read it?" but "when this ` + 'was written, what was true - and is it STILL true?" A note resting on a live quantity ' + '(a count, a status, a date, a "not yet") can stay accurate while the CONCLUSION drawn ' + "from it expires. If one is now wrong, update it - that is the maintenance half.";
}
function detectsHistoryRewrite(prompt) {
  if (!prompt)
    return false;
  return HISTORY_REWRITE_PATTERNS.some((re) => re.test(prompt));
}
function composeHistoryRewriteText() {
  return "[orch] THIS PROPOSES REWRITING GIT HISTORY - verify the STATE before you act on it, " + `not the REPORT of the state.
` + "  - Run `git log origin/main..HEAD` and `git log HEAD..origin/main` YOURSELF, now. " + "Confirm the commit you are about to rewrite is still where you think it is. If anything " + `landed on top, the plan changes.
` + "  - Check the WORKING TREE too, not just the remote. A remote-only check passes while a " + "value sits live in a tracked file, ready to re-arm on the next `git add`.\n" + "  - If this came from someone else's report rather than your own read, that is exactly " + "the case to re-verify: a directive issued on a stale report gets executed as though it " + `were verified.
` + "  - Prefer the SMALLEST operation that works (amend one tip commit) over a full-history " + "rewrite (filter-repo/BFG), and confirm any secret is gone with a pattern that matches how " + "the data is actually FORMATTED - `587-777` does not match `(587) 777`.\n" + "  This is near-irreversible and it is shared state. One read costs seconds.";
}
function findNotesDescribingEditedFiles(db, editedFiles, max = 4) {
  const out = [];
  const seenNotes = new Set;
  for (const file of editedFiles) {
    if (out.length >= max)
      break;
    const needle = JSON.stringify(file);
    let rows = [];
    try {
      rows = db.query(`SELECT id, type, content FROM notes
           WHERE code_refs IS NOT NULL AND code_refs LIKE ?
             AND superseded_by IS NULL AND resolved = 0
           ORDER BY COALESCE(signal, 0) DESC, updated_at DESC
           LIMIT 3`).all(`%${needle}%`);
    } catch {
      rows = [];
    }
    for (const r of rows) {
      if (out.length >= max)
        break;
      if (seenNotes.has(r.id))
        continue;
      seenNotes.add(r.id);
      out.push({ ...r, file });
    }
  }
  return out;
}
function composeWorkItemDriftNudge(db, sessionId, args) {
  const writeTool = args.tool_name === "Edit" || args.tool_name === "Write" || args.tool_name === "MultiEdit" || args.tool_name === "NotebookEdit";
  if (!writeTool)
    return "";
  const filePath = args.payload?.file_path;
  if (!filePath)
    return "";
  const needle = JSON.stringify(filePath);
  const rows = db.query(`SELECT id, content FROM notes
       WHERE type = 'work_item'
         AND COALESCE(status, '') NOT IN ('done', 'cancelled', 'completed')
         AND code_refs IS NOT NULL
         AND code_refs LIKE ?
       ORDER BY COALESCE(signal, 0) DESC, updated_at DESC
       LIMIT 3`).all(`%${needle}%`);
  if (rows.length === 0)
    return "";
  const fresh = rows.filter((r) => {
    const key = `wi_drift_${sessionId}_${r.id}`;
    const seen = db.query(`SELECT 1 FROM plugin_state WHERE key = ?`).get(key);
    if (seen)
      return false;
    db.run(`INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '1', ?)`, [key, now()]);
    return true;
  });
  if (fresh.length === 0)
    return "";
  const list = fresh.map((r) => `  - **${r.id.slice(0, 8)}**: ${r.content.slice(0, 80)}`).join(`
`);
  return `[orch] You just edited a file tied to in-flight work_item${fresh.length === 1 ? "" : "s"} (via code_refs):
${list}
  -> If your edit advances or completes the work_item, update_work_item NOW. If scope has shifted, update its content too. Don't let work_item descriptions drift out of sync with what you're actually doing - other agents look at them.`;
}
var HSO_EVENTS, HEDGE_PATTERNS, HEREDOC_RE, BACKSLASH_ESCAPE_RE, SESSION_TRAILER_WARNING, HEREDOC_WARNING, SCOPE_EXPANSION_PATTERNS, HISTORY_REWRITE_PATTERNS, EDIT_TOOLS, STOPWORDS;
var init_hook_event = __esm(() => {
  init_live_sessions();
  init_agent_channel_state();
  init_utils();
  init_connection();
  HSO_EVENTS = new Set([
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse"
  ]);
  HEDGE_PATTERNS = [
    /\bi think\b/i,
    /\bi believe\b/i,
    /\biirc\b/i,
    /\bif i recall\b/i,
    /\bwasn'?t there\b/i,
    /\bdidn'?t we\b/i,
    /\bdid we ever\b/i,
    /\bat some point\b/i,
    /\bi seem to remember\b/i,
    /\bpretty sure\b/i,
    /\bi vaguely\b/i,
    /\bwe used to\b/i,
    /\bisn'?t there (?:a|an|some)\b/i,
    /\bwhy (?:is|does|did) .{0,40}\b(again|still)\b/i
  ];
  HEREDOC_RE = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/;
  BACKSLASH_ESCAPE_RE = /\\[A-Za-z\\]/;
  SESSION_TRAILER_WARNING = "[orch] THIS COMMIT MESSAGE HAS NO `Claude-Session:` TRAILER, AND NOTHING " + "ELSE WILL EVER CHECK. The trailer is the authorship guarantee - it is the " + "only link between the commit and the session that produced it - and it is " + "typed by hand every time, so it fails silently and invisibly: git exits 0, " + "a SHA is printed, and the attribution is simply gone. Measured on this " + "project: 296 of the last 300 commits carry it and 4 do not, all four on a " + "single day, none of them noticed at the time. High compliance is diligence, " + "not a mechanism. Add both lines to the end of the message before running " + "this:  Co-Authored-By: ... and  Claude-Session: <your session URL>.  If " + "this commit deliberately has no trailer (a rebase fixup, a non-agent " + "commit), proceed - this is a fact, not a gate, and your judgment governs.";
  HEREDOC_WARNING = "[orch] THIS HEREDOC CONTAINS BACKSLASH ESCAPES AND WILL LIKELY REWRITE THEM " + "SILENTLY. Git Bash + the interpreter reading stdin + backslash-bearing " + "source is three escaping layers, and each REWRITES the content rather than " + "failing - you get a plausible-looking file, not an error. Observed six times " + "in one session: one truncated a source file to 0 bytes, one invented a bug " + "that did not exist and cost real debugging time, three produced silent " + "no-match or unterminated literals. Use Write for new files and Edit for " + "changes. If a shell script is genuinely required, String.raw and a quoted " + "delimiter each close one layer - but the reliable move is not to open them.";
  SCOPE_EXPANSION_PATTERNS = [
    /\b(?:can|could|should) we (?:also|now)\b/i,
    /\bwhat about\b/i,
    /\bwhile you'?re (?:at it|in there)\b/i,
    /\b(?:next|now),? (?:let'?s|can you|do|look at|move on)\b/i,
    /\b(?:switch|switching|pivot|pivoting|move) (?:to|over to|onto)\b/i,
    /\b(?:also|additionally|on top of that),? (?:improve|enhance|add|fix|update|check|look)\b/i,
    /\blet'?s (?:also|now)\b/i,
    /\bnew (?:task|topic|thing|area|scope)\b/i
  ];
  HISTORY_REWRITE_PATTERNS = [
    /\b(?:force[- ]?push|push\s+--force|--force-with-lease)\b/i,
    /\bgit\s+(?:commit\s+)?--amend\b/i,
    /\bamend\b[^.]{0,40}\b(?:commit|it|that|tip|head)\b/i,
    /\bgit\s+rebase\b|\brebase\b[^.]{0,30}\b(?:onto|interactive|-i)\b/i,
    /\b(?:filter-repo|filter-branch|bfg)\b/i,
    /\bgit\s+reset\s+--hard\b|\breset\s+--hard\b/i,
    /\bsquash[- ]and[- ]force\b/i,
    /\bsquash\b[^.]{0,40}\b(?:commit|history)\b/i,
    /\bdrop\s+(?:the\s+)?commit\b|\brewrite\s+(?:the\s+)?history\b/i
  ];
  EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
  STOPWORDS = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "if",
    "then",
    "else",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "to",
    "of",
    "in",
    "on",
    "at",
    "for",
    "with",
    "from",
    "by",
    "as",
    "into",
    "onto",
    "that",
    "this",
    "these",
    "those",
    "it",
    "its",
    "i",
    "you",
    "we",
    "they",
    "he",
    "she",
    "them",
    "us",
    "my",
    "your",
    "our",
    "their",
    "what",
    "when",
    "where",
    "why",
    "how",
    "which",
    "who",
    "whom",
    "not",
    "no",
    "yes",
    "so",
    "just",
    "also",
    "very",
    "really",
    "still",
    "only",
    "ever",
    "never",
    "more",
    "less",
    "most",
    "least",
    "some",
    "any",
    "all",
    "none",
    "each",
    "every",
    "one",
    "two",
    "new",
    "old",
    "make",
    "made",
    "get",
    "got",
    "let",
    "lets",
    "want",
    "need",
    "like",
    "try",
    "run",
    "use",
    "using",
    "add",
    "fix",
    "update",
    "check",
    "take",
    "show",
    "see",
    "look",
    "know",
    "think",
    "tell",
    "ask",
    "help",
    "work",
    "working",
    "working",
    "done",
    "ok",
    "okay",
    "now",
    "up",
    "down",
    "out",
    "back",
    "over",
    "under",
    "again",
    "much",
    "many",
    "few",
    "next",
    "last",
    "function",
    "functions",
    "method",
    "methods",
    "class",
    "classes",
    "interface",
    "interfaces",
    "type",
    "types",
    "value",
    "values",
    "variable",
    "variables",
    "parameter",
    "parameters",
    "argument",
    "arguments",
    "return",
    "returns",
    "import",
    "imports",
    "export",
    "exports",
    "module",
    "modules",
    "test",
    "tests",
    "testing",
    "spec",
    "specs",
    "mock",
    "mocks",
    "stub",
    "stubs",
    "error",
    "errors",
    "exception",
    "exceptions",
    "bug",
    "bugs",
    "issue",
    "issues",
    "problem",
    "problems",
    "code",
    "codes",
    "file",
    "files",
    "folder",
    "folders",
    "dir",
    "directory",
    "path",
    "paths",
    "string",
    "strings",
    "number",
    "numbers",
    "array",
    "arrays",
    "object",
    "objects",
    "null",
    "undefined",
    "state",
    "states",
    "prop",
    "props",
    "data",
    "items",
    "item",
    "list",
    "lists",
    "true",
    "false",
    "none",
    "void"
  ]);
});

// ../orchestrator/mcp/runtime/codex-hooks.ts
var exports_codex_hooks = {};
__export(exports_codex_hooks, {
  handleCodexHook: () => handleCodexHook,
  failedTool: () => failedTool,
  affectedFiles: () => affectedFiles
});
import { relative, resolve as resolve2, isAbsolute } from "path";
function affectedFiles(input, cwd) {
  const obj = input && typeof input === "object" ? input : {};
  const patch = typeof input === "string" ? input : [obj.command, obj.patch, obj.input].find((x) => typeof x === "string");
  const paths = [];
  if (typeof obj.file_path === "string")
    paths.push(obj.file_path);
  if (patch)
    for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm))
      paths.push(match[1].trim());
  return [...new Set(paths.map((file) => relative(cwd, resolve2(cwd, file)).replace(/\\/g, "/")))].filter((file) => file && file !== ".." && !file.startsWith("../") && !isAbsolute(file)).slice(0, 60);
}
function failedTool(response) {
  if (typeof response === "string")
    return /(?:exit_code["']?\s*[:=]\s*|Exit code:\s*|Process exited with code )([1-9]\d*)/.test(response);
  if (!response || typeof response !== "object")
    return false;
  const obj = response;
  return obj.isError === true || typeof obj.exit_code === "number" && obj.exit_code !== 0 || failedTool(obj.output);
}
function handleCodexHook(db, input) {
  const sid = codexSessionId(input.session_id);
  if (!sid)
    throw new Error("Codex hook has no valid task identity");
  const event = input.hook_event_name;
  const tracker = new SessionTracker(db, () => []);
  const get = (key, fallback) => {
    const row = db.query("SELECT value FROM plugin_state WHERE key = ?").get(`codex_${key}_${sid}`);
    try {
      return row ? JSON.parse(row.value) : fallback;
    } catch {
      return fallback;
    }
  };
  const put = (key, value) => db.run("INSERT INTO plugin_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", [`codex_${key}_${sid}`, JSON.stringify(value), new Date().toISOString()]);
  const envelope = (text) => text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text.slice(0, 1e4) } } : {};
  const checkpoint = () => db.query("SELECT id,content FROM notes WHERE type='checkpoint' AND source_session=? ORDER BY created_at DESC LIMIT 1").get(sid);
  put(`hook_${event}`, { count: get(`hook_${event}`, { count: 0 }).count + 1, at: new Date().toISOString() });
  if (event === "SessionStart") {
    tracker.registerSession(sid);
    const cp = checkpoint();
    const snapshot = get("snapshot", "");
    const task = tracker.getSession(sid)?.current_task;
    return envelope([
      `[orchestrator] Independent Codex task ${sid}. Use briefing to load project knowledge, then lookup/check_similar alongside current source. Capture findings and save_progress at milestones.`,
      task ? `Current task: ${task}` : "",
      cp ? `Your saved checkpoint ${cp.id}:
${cp.content.slice(0, 5000)}` : "",
      input.source === "compact" ? snapshot : ""
    ].filter(Boolean).join(`

`));
  }
  if (event === "UserPromptSubmit") {
    const turn = get("turn", 0) + 1;
    put("turn", turn);
    const prompt = input.prompt || "";
    const parts = [];
    if (detectsRetrievalTrigger(prompt)) {
      parts.push(composeScopeRetrievalText(findRelatedNotes(db, prompt, 3)));
    }
    const bridge = get("bridge", "");
    if (bridge)
      parts.push(`[orchestrator] Previous action: ${bridge}`);
    if (turn % 15 === 0)
      parts.push("[orchestrator] Capture new findings while the evidence is fresh; amend knowledge you found outdated.");
    return envelope(parts.filter(Boolean).join(`

`));
  }
  const name = input.tool_name || "";
  const edit = /(?:apply_patch|Write|Edit|MultiEdit|NotebookEdit)$/.test(name);
  const files = edit ? affectedFiles(input.tool_input, input.cwd) : [];
  if (event === "PreToolUse") {
    const parts = [];
    if (files.length) {
      const notes = findNotesDescribingEditedFiles(db, files, 6);
      if (notes.length)
        parts.push(`[orchestrator] Prior knowledge for the files being edited:
` + notes.map((n) => `${n.file}: ${n.id} \u2014 ${n.content.slice(0, 800)}`).join(`
`));
    }
    const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    const command = String(args.cmd || args.command || "");
    if (detectsRiskyHeredoc(command))
      parts.push(HEREDOC_WARNING);
    if (detectsHistoryRewrite(command))
      parts.push(composeHistoryRewriteText());
    return envelope(parts.join(`

`));
  }
  if (event === "PostToolUse") {
    const failed = failedTool(input.tool_response);
    if (failed) {
      const failures = get("failures", 0) + 1;
      put("failures", failures);
      return envelope(failures % 2 === 0 ? "[orchestrator] Repeated tool failures: check prior gotchas with lookup and re-read the current evidence before retrying." : "");
    }
    put("failures", 0);
    if (files.length) {
      put("edited", [...new Set([...get("edited", []), ...files])].slice(-60));
      put("dirty", true);
      put("bridge", `Edited ${files.join(", ")}`);
      const drift = files.slice(0, 12).map((file) => composeWorkItemDriftNudge(db, sid, { event: "PostToolUse", session_id: sid, tool_name: "Edit", payload: { file_path: file } })).filter(Boolean);
      return envelope(drift.join(`

`));
    } else if (/orchestrator.*(?:note|save_progress|work_item|session_task|lookup)/.test(name)) {
      put("bridge", name);
      if (/save_progress$/.test(name))
        put("dirty", false);
    }
    return {};
  }
  if (event === "PreCompact" || event === "SessionEnd") {
    const task = tracker.getSession(sid)?.current_task || "No task declaration";
    const notes = db.query("SELECT id,type,substr(content,1,220) AS content FROM notes WHERE source_session=? ORDER BY updated_at DESC LIMIT 8").all(sid);
    put("snapshot", `Deterministic continuity snapshot: ${task}
Edited files: ${get("edited", []).join(", ")}
Recent records: ${JSON.stringify(notes)}`);
    return {};
  }
  if (event === "Stop" && get("dirty", false) && !input.stop_hook_active) {
    const turn = input.turn_id || String(get("turn", 0));
    if (get("stop_requested", "") === turn)
      return {};
    put("stop_requested", turn);
    const notes = findNotesDescribingEditedFiles(db, get("edited", []), 5);
    return { decision: "block", reason: "Save useful progress with orchestrator save_progress before finishing. If the tool is unavailable, state that briefly and finish. " + (notes.length ? `Review whether these records need updating after your edits: ${notes.map((n) => n.id).join(", ")}.` : "") };
  }
  return {};
}
var init_codex_hooks = __esm(() => {
  init_session_tracker();
  init_linker();
  init_hook_event();
  init_profile();
});

// src/memory-hook.ts
import { join as join5 } from "path";

// src/bootstrap.ts
function helpRecoveryContext(input, result) {
  if (input.hook_event_name !== "SessionStart" || input.source !== "compact")
    return result;
  const output = result.hookSpecificOutput ?? {};
  return { ...result, hookSpecificOutput: {
    ...output,
    hookEventName: "SessionStart",
    additionalContext: `${output.additionalContext ?? ""}
[HELP] Context was compacted. Read discord-bootstrap using read_resource(kind="skill", name="discord-bootstrap") and refresh persona/policy and the conversation checkpoint before outward actions.`
  } };
}

// src/memory-hook.ts
var input = JSON.parse(await Bun.stdin.text());
process.env.ORCHESTRATOR_HOST = "codex";
process.env.ORCHESTRATOR_MODE = "standalone";
process.env.ORCHESTRATOR_PROJECT_ROOT = input.cwd;
process.env.ORCHESTRATOR_WORKTREE_ROOT = input.cwd;
process.env.ORCHESTRATOR_GLOBAL_DB = join5(input.cwd, ".orchestrator", "global.db");
process.env.ORCHESTRATOR_EMBEDDINGS = "off";
try {
  const { getProjectDb: getProjectDb2, closeAll: closeAll2 } = await Promise.resolve().then(() => (init_connection(), exports_connection));
  const { handleCodexHook: handleCodexHook2 } = await Promise.resolve().then(() => (init_codex_hooks(), exports_codex_hooks));
  try {
    console.log(JSON.stringify(helpRecoveryContext(input, handleCodexHook2(getProjectDb2(), input))));
  } finally {
    closeAll2();
  }
} catch (error) {
  console.error(String(error));
  console.log("{}");
}
