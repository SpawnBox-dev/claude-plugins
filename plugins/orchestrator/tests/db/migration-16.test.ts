import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";

describe("migration 16: plugin_state", () => {
  test("creates plugin_state table with expected columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const cols = db.query("PRAGMA table_info(plugin_state)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of ["key", "value", "updated_at"]) {
      expect(names).toContain(expected);
    }
  });

  test("key is primary key", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const cols = db.query("PRAGMA table_info(plugin_state)").all() as Array<{ name: string; pk: number }>;
    const keyCol = cols.find((c) => c.name === "key");
    expect(keyCol?.pk).toBe(1);
  });

  test("idempotent", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    expect(() => applyMigrations(db, "project")).not.toThrow();
  });

  test("INSERT OR REPLACE works on existing key", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const ts1 = "2026-01-01T00:00:00Z";
    const ts2 = "2026-02-01T00:00:00Z";
    db.run(
      `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['test_key', 'v1', ts1]
    );
    db.run(
      `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['test_key', 'v2', ts2]
    );
    const row = db.query("SELECT value, updated_at FROM plugin_state WHERE key = 'test_key'").get() as any;
    expect(row.value).toBe('v2');
    expect(row.updated_at).toBe(ts2);
  });
});
