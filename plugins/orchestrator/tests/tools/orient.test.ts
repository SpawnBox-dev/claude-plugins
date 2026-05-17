import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleOrient, capWithMarker } from "../../mcp/tools/orient";
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

  test("returns strategic briefing on startup with data", async () => {
    // Seed some notes
    await handleRemember(projectDb, globalDb, {
      content: "Implement observer architecture for frontend/backend decoupling",
      type: "open_thread",
      tags: "architecture",
    });
    await handleRemember(projectDb, globalDb, {
      content: "Use Zustand for state management",
      type: "decision",
      tags: "frontend",
    });
    await handleRemember(projectDb, globalDb, {
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
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "checkpoint-1",
        "checkpoint",
        "Last session: completed observer phase 14, starting phase 15",
        null,
        "observer,phase,checkpoint",
        "checkpoint",
        "high",
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

  // =========================================================================
  // 05f072d3: briefing token budget. briefing() is the mandatory first call
  // of every session; if the assembled output exceeds the model tool-output
  // limit the call returns an ERROR (observed live 2026-05-17: 150,759 chars
  // broke cold-start for SA-38a119fd AND PA independently). The render must be
  // bounded by CONSTRUCTION, and any truncation must be HONEST (an explicit
  // "truncated / page via" marker, never a silent omission - handoff
  // fidelity: a truthful stub beats silently dropping load-bearing context).
  // =========================================================================

  // Skip the auto-retro side-effect so these tests isolate the render path.
  function suppressAutoRetro(db: Database) {
    const ts = now();
    db.run(
      `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ["last_retro_run_at", ts, ts]
    );
  }

  const HARD_CEILING = 60000;

  test("cold-start briefing stays under the hard ceiling even with a pathological KB", async () => {
    suppressAutoRetro(projectDb);

    // A checkpoint with a quarter-million-char body (the dominant real-world
    // overflow contributor - save_progress checkpoints accrete).
    const huge = "X".repeat(250_000);
    const ts = now();
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["checkpoint-huge", "checkpoint", `HEAD-MARKER ${huge} TAIL-MARKER`, null, "checkpoint", "checkpoint", "high", 0, ts, ts]
    );
    // Plus many large work items + threads + decisions to stress every section.
    for (let i = 0; i < 40; i++) {
      const body = `item ${i} ` + "Y".repeat(5000);
      projectDb.run(
        `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [generateId(), i % 2 === 0 ? "work_item" : "open_thread", body, null, "k", "stress", "medium", 0, "active", "high", ts, ts]
      );
    }

    const result = handleOrient(projectDb, globalDb, { event: "startup" });

    // AC (a): never exceeds the budget (the original crash mode).
    expect(result.formatted.length).toBeLessThanOrEqual(HARD_CEILING);
    // AC (b): degrades to TRUNCATED-BUT-USABLE, never error-instead-of-usable.
    // Load-bearing sections must still be present, not an empty stub.
    expect(result.formatted).toContain("Session Briefing");
    expect(result.formatted).toContain("Recovery Checkpoint");
    expect(result.formatted).toContain("Work Items");
    // AC (c): the truncation that DID happen is visibly, honestly signalled.
    expect(result.formatted.toLowerCase()).toContain("truncated");
  });

  test("a truncated checkpoint is HONEST: explicit marker + pointer to the full note", async () => {
    suppressAutoRetro(projectDb);
    const huge = "Z".repeat(120_000);
    const ts = now();
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["checkpoint-trunc", "checkpoint", `START ${huge} END`, null, "checkpoint", "checkpoint", "high", 0, ts, ts]
    );

    const result = handleOrient(projectDb, globalDb, { event: "compact" });

    // Honest: the render says it truncated AND how to get the full content.
    expect(result.formatted.toLowerCase()).toContain("truncated");
    expect(result.formatted).toContain("checkpoint-trunc");
    // The raw recovery_checkpoint object is still complete (not mutated).
    expect(result.recovery_checkpoint!.content).toContain("START");
    expect(result.recovery_checkpoint!.content.length).toBeGreaterThan(100_000);
  });

  test("normal small KB renders fully with NO truncation noise (no common-path regression)", async () => {
    suppressAutoRetro(projectDb);
    await handleRemember(projectDb, globalDb, {
      content: "Implement observer architecture",
      type: "open_thread",
      tags: "architecture",
    });
    await handleRemember(projectDb, globalDb, {
      content: "Use Zustand for state management",
      type: "decision",
      tags: "frontend",
    });

    const result = handleOrient(projectDb, globalDb, { event: "startup" });

    expect(result.formatted).toContain("Session Briefing");
    expect(result.formatted.toLowerCase()).not.toContain("truncated");
    expect(result.formatted).not.toContain("call briefing({sections");
  });

  // Review C1 lock: the marker must fit WITHIN the budget, not be appended
  // past it - otherwise the "hard ceiling" overshoots by marker.length and
  // AC (a) is false by construction.
  test("AC (a) lock: capWithMarker result NEVER exceeds the cap", () => {
    const marker = "\n...[truncated - page via briefing({sections:[...]})]";
    const out = capWithMarker("X".repeat(100_000), 6000, marker);
    expect(out.length).toBe(6000);
    expect(out.endsWith(marker)).toBe(true);
    // No truncation => returned unchanged, no marker noise.
    expect(capWithMarker("short text", 6000, marker)).toBe("short text");
    // Degenerate: cap smaller than the marker must still not exceed cap.
    expect(capWithMarker("X".repeat(50), 10, marker).length).toBeLessThanOrEqual(10);
  });

  test("AC (c): an over-cap section pages HONESTLY - explicit count + how to retrieve the rest, never a silent drop", () => {
    suppressAutoRetro(projectDb);
    // 45 distinct tags, all on notes untouched for 10 days => every tag is a
    // "neglected area". Exceeds NEGLECTED_MAX (30), forcing the cap path -
    // the same honest-paging code path cross_session/user_model use.
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 45; i++) {
      projectDb.run(
        `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [generateId(), "decision", `d${i}`, null, "k", `area-${i}`, "medium", 0, old, old]
      );
    }

    const result = handleOrient(projectDb, globalDb, { event: "startup" });

    // Honest: states HOW MANY were withheld and HOW to get them. Never a
    // silent truncation (a confident-but-lossy briefing is worse than an
    // honest overflow - the don't-mask-the-failure guardrail).
    expect(result.formatted).toContain("Neglected Areas");
    expect(result.formatted).toMatch(/\.\.\.and \d+ more/);
    expect(result.formatted).toContain('call briefing({sections:["neglected"]})');
  });

  // c658ce38: a note whose tags column holds a JSON-array-stringified value
  // must NOT char-split into bracket/quote garbage in Neglected Areas.
  test("c658ce38: JSON-array tags render as clean neglected tags, not char-split garbage", () => {
    suppressAutoRetro(projectDb);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        "decision",
        "a decision with array-shaped tags",
        null,
        "k",
        '["alpha-c658","beta-c658"]',
        "medium",
        0,
        old,
        old,
      ]
    );

    const result = handleOrient(projectDb, globalDb, { event: "startup" });

    expect(result.formatted).toContain("Neglected Areas");
    // Clean tag lines.
    expect(result.formatted).toContain("- alpha-c658");
    expect(result.formatted).toContain("- beta-c658");
    // No JSON-array char-split artifacts.
    expect(result.formatted).not.toContain('["alpha-c658');
    expect(result.formatted).not.toContain('beta-c658"]');
    expect(result.formatted).not.toContain('"alpha-c658"');
  });
});
