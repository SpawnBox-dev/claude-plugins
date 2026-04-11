import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { applyMigrations } from "./schema";

let globalDb: Database | null = null;
let projectDb: Database | null = null;

/**
 * Returns the path to the global orchestrator database.
 * ~/.claude/orchestrator/global.db
 * Migrates from legacy ~/.orchestrator/global.db if it exists.
 */
export function getGlobalDbPath(): string {
  const newPath = join(homedir(), ".claude", "orchestrator", "global.db");
  const legacyPath = join(homedir(), ".orchestrator", "global.db");

  // Migrate from legacy location if new doesn't exist but old does
  if (!existsSync(newPath) && existsSync(legacyPath)) {
    const newDir = dirname(newPath);
    if (!existsSync(newDir)) {
      mkdirSync(newDir, { recursive: true });
    }
    // Copy DB + WAL + SHM files
    const { copyFileSync } = require("node:fs") as typeof import("node:fs");
    copyFileSync(legacyPath, newPath);
    for (const suffix of ["-wal", "-shm"]) {
      const src = legacyPath + suffix;
      if (existsSync(src)) {
        copyFileSync(src, newPath + suffix);
      }
    }
  }

  return newPath;
}

/**
 * Returns the path to the project-scoped orchestrator database.
 * Checks env vars in order: ORCHESTRATOR_PROJECT_ROOT, CLAUDE_PROJECT_DIR, then cwd.
 * CRITICAL: process.cwd() for plugin MCP servers resolves to the plugin cache
 * directory, NOT the user's project. Plugin updates wipe the cache, destroying
 * any DB stored there. We MUST use an env var to find the real project root.
 */
export function getProjectDbPath(): string {
  const root =
    process.env.ORCHESTRATOR_PROJECT_ROOT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  // Safety check: if we're inside a plugin cache directory, warn loudly
  if (root.includes(".claude/plugins/cache") || root.includes(".claude\\plugins\\cache")) {
    console.error(
      `[orchestrator] WARNING: Project DB path resolves to plugin cache (${root}). ` +
      `DB will be lost on plugin update! Set ORCHESTRATOR_PROJECT_ROOT or ensure CLAUDE_PROJECT_DIR is available.`
    );
  }

  return join(root, ".orchestrator", "project.db");
}

function initDb(path: string, dbType: "project" | "global"): Database {
  // Ensure parent directory exists (try/catch: bun's mkdirSync throws EEXIST on Windows)
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  // WAL allows concurrent readers but writers still serialize. Without a
  // busy timeout, a concurrent writer throws SQLITE_BUSY immediately instead
  // of waiting. v0.16+ explicitly runs N concurrent MCP server processes
  // against one DB, so this is required - any overlapping registerSession,
  // logSurfaced, updateLastBriefing, or note insert from sibling sessions
  // would flake intermittently without it.
  db.run("PRAGMA busy_timeout = 5000");

  applyMigrations(db, dbType);

  return db;
}

/**
 * Returns the lazily-initialized global database connection.
 * WAL mode, foreign keys ON, global migrations applied.
 */
export function getGlobalDb(): Database {
  if (!globalDb) {
    globalDb = initDb(getGlobalDbPath(), "global");
  }
  return globalDb;
}

/**
 * Returns the lazily-initialized project database connection.
 * WAL mode, foreign keys ON, project migrations applied.
 */
export function getProjectDb(): Database {
  if (!projectDb) {
    projectDb = initDb(getProjectDbPath(), "project");
  }
  return projectDb;
}

/**
 * Closes both database connections and resets the singletons.
 */
export function closeAll(): void {
  if (globalDb) {
    globalDb.close();
    globalDb = null;
  }
  if (projectDb) {
    projectDb.close();
    projectDb = null;
  }
}
