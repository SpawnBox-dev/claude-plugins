import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
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
 * $ORCHESTRATOR_PROJECT_ROOT/.orchestrator/project.db (fallback to cwd)
 */
export function getProjectDbPath(): string {
  const root = process.env.ORCHESTRATOR_PROJECT_ROOT || process.cwd();
  return join(root, ".orchestrator", "project.db");
}

function initDb(path: string, dbType: "project" | "global"): Database {
  // Ensure parent directory exists
  mkdirSync(dirname(path), { recursive: true });

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
