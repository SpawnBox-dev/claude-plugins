import type { Database } from "bun:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  customApply?: (db: Database) => void;
}

/**
 * Base migrations applied to both project and global databases.
 */
export const MIGRATIONS: Migration[] = [
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
`,
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
`,
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
`,
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
`,
  },
  {
    version: 5,
    name: "add_work_item_fields",
    sql: `
ALTER TABLE notes ADD COLUMN status TEXT;
ALTER TABLE notes ADD COLUMN priority TEXT;
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
CREATE INDEX IF NOT EXISTS idx_notes_priority ON notes(priority);
`,
  },
  {
    version: 6,
    name: "add_due_date",
    sql: `
ALTER TABLE notes ADD COLUMN due_date TEXT;
CREATE INDEX IF NOT EXISTS idx_notes_due_date ON notes(due_date);
`,
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
`,
  },
  {
    version: 8,
    name: "add_activation_tracking",
    sql: `
ALTER TABLE notes ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE notes ADD COLUMN last_accessed_at TEXT;
`,
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
`,
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
`,
  },
  {
    version: 11,
    name: "add_signal_column",
    // Wrapped in a check to handle the column already existing (e.g., manual DB manipulation)
    sql: `
CREATE TABLE IF NOT EXISTS _signal_migration_check (x);
DROP TABLE _signal_migration_check;
`,
    // Custom apply: handled in applyMigrations via special case
    customApply: (db) => {
      // Check if signal column already exists
      const cols = db.query("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "signal")) {
        db.exec("ALTER TABLE notes ADD COLUMN signal REAL DEFAULT 0");
      }
      // Seed from access_count if it exists
      const hasAccessCount = cols.some((c) => c.name === "access_count");
      if (hasAccessCount) {
        db.exec("UPDATE notes SET signal = CAST(COALESCE(access_count, 0) AS REAL) WHERE signal = 0 OR signal IS NULL");
      }
    },
  },
  {
    version: 12,
    name: "drop_access_count",
    sql: `SELECT 1;`, // no-op SQL; actual work in customApply
    customApply: (db) => {
      const cols = db.query("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "access_count")) {
        db.exec("ALTER TABLE notes DROP COLUMN access_count");
      }
    },
  },
];

/**
 * Global-only migrations (version 100+).
 */
const GLOBAL_MIGRATIONS: Migration[] = [
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
`,
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
`,
  },
];

/**
 * Returns the appropriate migrations for the given database type.
 */
export function getMigrations(dbType: "project" | "global" = "project"): Migration[] {
  if (dbType === "global") {
    return [...MIGRATIONS, ...GLOBAL_MIGRATIONS];
  }
  return [...MIGRATIONS];
}

/**
 * Bootstrap the migrations tracking table, then apply any pending migrations.
 * Idempotent - safe to call multiple times.
 */
export function applyMigrations(
  db: Database,
  dbType: "project" | "global" = "project"
): void {
  // Bootstrap the migrations tracking table first
  db.run(`
    CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
    );
  `);

  const migrations = getMigrations(dbType);

  // Get already-applied versions
  const applied = new Set(
    (db.query("SELECT version FROM migrations").all() as { version: number }[]).map(
      (r) => r.version
    )
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.run("BEGIN");
    try {
      // Use customApply if available (for idempotent/conditional migrations)
      if (migration.customApply) {
        migration.customApply(db);
      } else {
        db.exec(migration.sql);
      }

      // Record the migration
      db.run(
        "INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, new Date().toISOString()]
      );

      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${err}`
      );
    }
  }
}
