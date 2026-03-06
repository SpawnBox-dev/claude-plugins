import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations, getMigrations, MIGRATIONS } from "../../mcp/db/schema";

describe("Database Schema", () => {
  test("applies all migrations without error", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");

    // Verify core tables exist
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("notes");
    expect(tableNames).toContain("links");
    expect(tableNames).toContain("migrations");

    db.close();
  });

  test("creates FTS5 virtual table for notes", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("notes_fts");

    db.close();
  });

  test("creates user_model table in global context", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "global");

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("user_model");
    expect(tableNames).toContain("autonomy_scores");

    db.close();
  });

  test("is idempotent - applying twice does not error", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "global");
    applyMigrations(db, "global");

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("notes");
    expect(tableNames).toContain("user_model");

    db.close();
  });

  test("tracks applied migrations", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "global");

    const applied = db
      .query("SELECT version, name FROM migrations ORDER BY version")
      .all() as { version: number; name: string }[];

    const globalMigrations = getMigrations("global");
    expect(applied.length).toBe(globalMigrations.length);

    // Verify first and last
    expect(applied[0].version).toBe(1);
    expect(applied[0].name).toBe("create_notes");
    expect(applied[applied.length - 1].version).toBe(101);
    expect(applied[applied.length - 1].name).toBe("create_autonomy_scores");

    db.close();
  });
});
