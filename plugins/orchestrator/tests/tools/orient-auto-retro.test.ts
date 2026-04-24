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

// R5.2 Critical-1: empty-DB guard - auto-retro must NOT burn the 7-day retro
// window on a first run that has zero notes. If it fires and writes the
// cursor, the next session (2 days later, with actual notes) skips retro.
describe("R5.2 Critical-1: auto-retro empty-DB guard", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = new Database(":memory:");
    applyMigrations(projectDb, "project");
    globalDb = new Database(":memory:");
    applyMigrations(globalDb, "global");
    // NO seeded notes - this is the first-run scenario.
  });

  test("auto-retro does NOT fire on empty DB", () => {
    handleOrient(projectDb, globalDb, { event: "startup" });
    const row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    // Cursor not written - next session with actual notes can still retro.
    expect(row).toBeNull();
  });

  test("auto-retro fires on the FIRST session that has notes", async () => {
    // Simulate first-run empty session: no retro, no cursor.
    handleOrient(projectDb, globalDb, { event: "startup" });
    expect(
      projectDb.query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'").get()
    ).toBeNull();

    // Second session: now there's a note. Retro should fire.
    await handleRemember(projectDb, globalDb, {
      content: "first real note in this project",
      type: "decision",
    });
    handleOrient(projectDb, globalDb, { event: "startup" });
    const row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    expect(row).toBeTruthy();
    expect(row.value).toBeTruthy();
  });
});

// R5.2 Critical-2: when handleReflect throws mid-run, the cursor must still
// be advanced so auto-retro doesn't re-attempt the broken pass on each
// subsequent startup (which would double-decay signals).
describe("R5.2 Critical-2: auto-retro finally block advances cursor on failure", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(async () => {
    projectDb = new Database(":memory:");
    applyMigrations(projectDb, "project");
    globalDb = new Database(":memory:");
    applyMigrations(globalDb, "global");
    // Non-empty so the empty-DB guard passes and retro is actually attempted.
    await handleRemember(projectDb, globalDb, {
      content: "seed note so retro is eligible",
      type: "decision",
    });
  });

  test("cursor advances even when handleReflect throws", () => {
    // Close globalDb so handleReflect's first mutation on it throws.
    globalDb.close();
    // handleOrient must not re-throw; briefing must still render; cursor
    // must be advanced (the finally block).
    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(result).toBeTruthy();
    expect(result.formatted).toBeTruthy();
    const row = projectDb
      .query("SELECT value FROM plugin_state WHERE key = 'last_retro_run_at'")
      .get() as any;
    expect(row).toBeTruthy();
    expect(row.value).toBeTruthy();
  });
});
