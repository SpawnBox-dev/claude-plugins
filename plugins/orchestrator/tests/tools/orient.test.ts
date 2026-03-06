import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleOrient } from "../../mcp/tools/orient";
import { handleRemember } from "../../mcp/tools/remember";
import { generateId, now } from "../../mcp/utils";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("orient tool", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("detects first run on empty database", () => {
    const result = handleOrient(projectDb, globalDb, { event: "startup" });

    expect(result.briefing.is_first_run).toBe(true);
    expect(result.briefing.open_threads).toHaveLength(0);
    expect(result.briefing.recent_decisions).toHaveLength(0);
    expect(result.formatted).toContain("orchestrator-init");
    expect(result.recovery_checkpoint).toBeNull();
  });

  test("returns strategic briefing on startup with data", () => {
    // Seed some notes
    handleRemember(projectDb, globalDb, {
      content: "Implement observer architecture for frontend/backend decoupling",
      type: "open_thread",
      tags: "architecture",
    });
    handleRemember(projectDb, globalDb, {
      content: "Use Zustand for state management",
      type: "decision",
      tags: "frontend",
    });
    handleRemember(projectDb, globalDb, {
      content: "Backup system needs retention policy",
      type: "commitment",
      tags: "backend",
    });

    const result = handleOrient(projectDb, globalDb, { event: "startup" });

    expect(result.briefing.is_first_run).toBe(false);
    expect(result.briefing.open_threads.length).toBeGreaterThanOrEqual(1);
    expect(result.briefing.recent_decisions.length).toBeGreaterThanOrEqual(1);
    expect(result.formatted).toContain("Session Briefing");
    expect(result.formatted).toContain("Open Threads");
  });

  test("returns checkpoint on compaction recovery", () => {
    // Seed a checkpoint note
    const ts = now();
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, last_validated, resolved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "checkpoint-1",
        "checkpoint",
        "Last session: completed observer phase 14, starting phase 15",
        null,
        "observer,phase,checkpoint",
        "checkpoint",
        "high",
        ts,
        0,
        ts,
        ts,
      ]
    );

    const result = handleOrient(projectDb, globalDb, { event: "compact" });

    expect(result.recovery_checkpoint).toBeTruthy();
    expect(result.recovery_checkpoint!.id).toBe("checkpoint-1");
    expect(result.recovery_checkpoint!.content).toContain("observer phase 14");
  });
});
