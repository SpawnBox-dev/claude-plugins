import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleOrient } from "../../mcp/tools/orient";
import { handleRemember } from "../../mcp/tools/remember";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

// Seed a non-empty DB so briefing isn't in "first run" mode and renders the
// full briefing body (which the auto-retro summary prepends to).
async function seedMinimal(projectDb: Database, globalDb: Database): Promise<void> {
  await handleRemember(projectDb, globalDb, {
    content: "seed decision for auto-retro tests",
    type: "decision",
    tags: "test",
  });
}

describe("R4.4: auto-retro gate on briefing", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(async () => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
    await seedMinimal(projectDb, globalDb);
  });

  test("auto-retro fires on first startup briefing (no plugin_state row)", async () => {
    handleOrient(projectDb, globalDb, { event: "startup" });
    const row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    expect(row).toBeTruthy();
    expect(row.value).toBeTruthy();
  });

  test("auto-retro skipped when last run was recent (< 7 days)", async () => {
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    projectDb.run(
      `INSERT INTO plugin_state (key, value, updated_at) VALUES ('last_retro_run_at', ?, ?)`,
      [recent, recent]
    );
    handleOrient(projectDb, globalDb, { event: "startup" });
    const row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    // timestamp should NOT have advanced since no retro fired
    expect(row.value).toBe(recent);
  });

  test("auto-retro fires when last run was > 7 days ago", async () => {
    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    projectDb.run(
      `INSERT INTO plugin_state (key, value, updated_at) VALUES ('last_retro_run_at', ?, ?)`,
      [stale, stale]
    );
    handleOrient(projectDb, globalDb, { event: "startup" });
    const row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    expect(row.value).not.toBe(stale); // timestamp advanced
    expect(new Date(row.value).getTime()).toBeGreaterThan(new Date(stale).getTime());
  });

  test("auto-retro does NOT fire on event=resume", async () => {
    handleOrient(projectDb, globalDb, { event: "resume" });
    const row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    expect(row).toBeNull(); // no plugin_state row written
  });

  test("auto-retro does NOT fire on event=clear or event=compact", async () => {
    handleOrient(projectDb, globalDb, { event: "clear" });
    let row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    expect(row).toBeNull();

    handleOrient(projectDb, globalDb, { event: "compact" });
    row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    expect(row).toBeNull();
  });

  test("briefing still works when plugin_state has a malformed timestamp", async () => {
    projectDb.run(
      `INSERT INTO plugin_state (key, value, updated_at) VALUES ('last_retro_run_at', ?, ?)`,
      ['not-a-date', '2026-01-01T00:00:00Z']
    );
    // Malformed ISO triggers auto-retro attempt; handler should degrade gracefully
    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(result).toBeTruthy();
    expect(result.formatted).toBeTruthy();
    // Auto-retro fires (malformed => trigger) and overwrites the bad value
    const row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    expect(row.value).not.toBe('not-a-date');
  });

  test("auto-retro summary is prepended to formatted briefing when it fires", async () => {
    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(result.formatted).toContain("## Auto-Retro");
    // Briefing body still renders below
    expect(result.formatted).toContain("# Session Briefing");
  });
});
