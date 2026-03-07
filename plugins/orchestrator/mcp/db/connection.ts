import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { applyMigrations } from "./schema";

let globalDb: Database | null = null;
let projectDb: Database | null = null;

/**
 * Returns the path to the global orchestrator database.
 * ~/.orchestrator/global.db
 */
export function getGlobalDbPath(): string {
  return join(homedir(), ".orchestrator", "global.db");
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
