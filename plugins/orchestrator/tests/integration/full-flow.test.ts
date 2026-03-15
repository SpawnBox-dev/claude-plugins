import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleOrient } from "../../mcp/tools/orient";
import { handleRemember } from "../../mcp/tools/remember";
import { handleRecall } from "../../mcp/tools/recall";
import { handlePrepare } from "../../mcp/tools/prepare";
import { handleReflect } from "../../mcp/tools/reflect";
import { findRelatedNotesHybrid } from "../../mcp/engine/linker";
import { SessionTracker } from "../../mcp/engine/session_tracker";
import { generateId, now } from "../../mcp/utils";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("full session lifecycle", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("completes a full session lifecycle", async () => {
    // 1. Orient on empty DB - should detect first run
    const firstOrient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(firstOrient.briefing.is_first_run).toBe(true);
    expect(firstOrient.recovery_checkpoint).toBeNull();

    // 2. Remember several notes simulating onboarding
    const arch1 = await handleRemember(projectDb, globalDb, {
      content: "SpawnBox is a Tauri v2 desktop app for managing Minecraft servers",
      type: "architecture",
      tags: "overview,tauri,minecraft",
    });
    expect(arch1.stored).toBe(true);
    expect(arch1.note_id).toBeTruthy();

    const arch2 = await handleRemember(projectDb, globalDb, {
      content: "Observer architecture: backend is always running, frontend connects/disconnects",
      type: "architecture",
      tags: "observer,backend,frontend",
    });
    expect(arch2.stored).toBe(true);

    const thread1 = await handleRemember(projectDb, globalDb, {
      content: "Phase 15C needs service spawning in standalone backend",
      type: "open_thread",
      tags: "observer,backend,phase-15",
    });
    expect(thread1.stored).toBe(true);

    const userPat = await handleRemember(projectDb, globalDb, {
      content: "User prefers architecturally elegant solutions over simple ones",
      type: "user_pattern",
    });
    expect(userPat.stored).toBe(true);

    const antiPat = await handleRemember(projectDb, globalDb, {
      content: "Never modify applied SQL migrations - causes checksum mismatch panic",
      type: "anti_pattern",
      tags: "backend,database",
    });
    expect(antiPat.stored).toBe(true);

    const toolCap = await handleRemember(projectDb, globalDb, {
      content: "Tauri MCP can execute JS in webview, navigate, interact with DOM",
      type: "tool_capability",
    });
    expect(toolCap.stored).toBe(true);

    const qualGate = await handleRemember(projectDb, globalDb, {
      content: "Before declaring frontend work done, verify via Tauri MCP that UI loads",
      type: "quality_gate",
      tags: "frontend,verification",
    });
    expect(qualGate.stored).toBe(true);

    // 3. Orient again - should NOT be first_run, should have open_threads >= 1
    const secondOrient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(secondOrient.briefing.is_first_run).toBe(false);
    expect(secondOrient.briefing.open_threads.length).toBeGreaterThanOrEqual(1);

    // 4. Recall "observer architecture" - should find results
    const recallResult = handleRecall(projectDb, globalDb, {
      query: "observer architecture",
    });
    expect(recallResult.results.length).toBeGreaterThan(0);
    const observerNote = recallResult.results.find((r) =>
      r.content.includes("Observer architecture")
    );
    expect(observerNote).toBeTruthy();

    // 5. Prepare for "Fix backup UI component" - should return quality_gates and tool_capabilities
    const prepResult = handlePrepare(projectDb, globalDb, {
      task: "Fix backup UI component",
    });
    // The task mentions "UI component" which infers frontend domain
    // quality_gates and tool_capabilities should be populated from global DB
    expect(prepResult.package).toBeDefined();
    expect(prepResult.formatted).toContain("Context Package");

    // 6. Remember a decision
    const decision = await handleRemember(projectDb, globalDb, {
      content: "Chose progressive disclosure for orchestrator MCP tools",
      type: "decision",
      tags: "orchestrator,architecture",
    });
    expect(decision.stored).toBe(true);

    // 7. Remember a checkpoint
    const checkpoint = await handleRemember(projectDb, globalDb, {
      content: "Working on orchestrator plugin. Done: schema, types, engine. Next: MCP server wiring.",
      type: "checkpoint",
    });
    expect(checkpoint.stored).toBe(true);

    // 8. Orient with any event now returns checkpoint (always fetched)
    const compactOrient = handleOrient(projectDb, globalDb, { event: "compact" });
    expect(compactOrient.recovery_checkpoint).toBeTruthy();
    expect(compactOrient.recovery_checkpoint!.content).toContain("orchestrator plugin");

    // Startup also gets checkpoint now
    const startupOrient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(startupOrient.recovery_checkpoint).toBeTruthy();

    // 9. Reflect - should have autonomy_scores defined
    const reflectResult = handleReflect(projectDb, globalDb, {});
    expect(reflectResult.autonomy_scores).toBeDefined();
    expect(Object.keys(reflectResult.autonomy_scores).length).toBeGreaterThan(0);
    // Should have scores for standard domains
    expect(reflectResult.autonomy_scores).toHaveProperty("frontend");
    expect(reflectResult.autonomy_scores).toHaveProperty("backend");

    // 10. Verify user_pattern went to global DB (not project DB)
    const globalUserPatterns = globalDb
      .query("SELECT * FROM notes WHERE type = 'user_pattern'")
      .all() as any[];
    expect(globalUserPatterns.length).toBe(1);
    expect(globalUserPatterns[0].content).toContain("architecturally elegant");

    const projectUserPatterns = projectDb
      .query("SELECT * FROM notes WHERE type = 'user_pattern'")
      .all() as any[];
    expect(projectUserPatterns.length).toBe(0);

    // 11. Verify tool_capability went to global DB
    const globalToolCaps = globalDb
      .query("SELECT * FROM notes WHERE type = 'tool_capability'")
      .all() as any[];
    expect(globalToolCaps.length).toBe(1);
    expect(globalToolCaps[0].content).toContain("Tauri MCP");

    const projectToolCaps = projectDb
      .query("SELECT * FROM notes WHERE type = 'tool_capability'")
      .all() as any[];
    expect(projectToolCaps.length).toBe(0);
  });

  test("prepare returns autonomy level", async () => {
    // With no knowledge, domain should be sparse
    const result = handlePrepare(projectDb, globalDb, {
      task: "Build a React component for player list",
    });
    expect(result.autonomy).toBe("sparse");
    expect(result.formatted).toContain("SPARSE");

    // Add frontend knowledge (autonomy counts: recipe + gate + anti_pattern, threshold 5)
    // Each note must be distinct enough to avoid dedup (Jaccard > 0.6 = duplicate)
    const frontendNotes = [
      { content: "Always use semantic HTML elements with aria labels for accessibility in frontend", type: "autonomy_recipe" as const },
      { content: "DaisyUI tooltip component is buggy, use SmartTooltip wrapper instead", type: "autonomy_recipe" as const },
      { content: "Zustand selectors must never return new objects, use module-level EMPTY constants", type: "autonomy_recipe" as const },
      { content: "Verify rendered page loads via Tauri MCP webview before marking frontend done", type: "quality_gate" as const },
      { content: "Never use inline styles, always Tailwind utility classes for consistency", type: "anti_pattern" as const },
    ];
    for (const note of frontendNotes) {
      await handleRemember(projectDb, globalDb, {
        content: note.content,
        type: note.type,
        tags: "frontend",
      });
    }

    // Now should be developing (total = 5)
    const result2 = handlePrepare(projectDb, globalDb, {
      task: "Build a React component for server status",
    });
    expect(result2.autonomy).toBe("developing");
    expect(result2.formatted).toContain("DEVELOPING");
  });

  test("checkpoint tool creates recoverable state", async () => {
    // Create a checkpoint
    const cp = await handleRemember(projectDb, globalDb, {
      content: "## Work State\nImplemented all 7 knowledge engine gaps\n\n## Next Steps\n- Rebuild bundle\n- Push to marketplace",
      type: "checkpoint",
      context: "Checkpoint created at end of session",
    });
    expect(cp.stored).toBe(true);

    // Orient should find it
    const orient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(orient.recovery_checkpoint).toBeTruthy();
    expect(orient.recovery_checkpoint!.content).toContain("knowledge engine gaps");
    expect(orient.formatted).toContain("Recovery Checkpoint");
  });

  test("cross-project patterns appear in orient", async () => {
    // Add a global convention
    await handleRemember(projectDb, globalDb, {
      content: "Always use TypeScript strict mode across all projects",
      type: "convention",
      scope: "global",
    });

    // Add some project notes so it's not first_run
    await handleRemember(projectDb, globalDb, {
      content: "Project uses React 18",
      type: "architecture",
    });

    const orient = handleOrient(projectDb, globalDb, { event: "startup" });
    expect(orient.formatted).toContain("Cross-Project Patterns");
    expect(orient.formatted).toContain("TypeScript strict mode");
  });

  test("handles the recursive improvement pattern", async () => {
    // 1. Remember an anti_pattern about editing files
    const antiPat = await handleRemember(projectDb, globalDb, {
      content: "Used sed to edit a file instead of the Edit tool - lost formatting",
      type: "anti_pattern",
      tags: "tooling,agent-mistake",
    });
    expect(antiPat.stored).toBe(true);
    expect(antiPat.note_id).toBeTruthy();

    // 2. Remember an autonomy_recipe for dev app status
    const recipe = await handleRemember(projectDb, globalDb, {
      content: "To check dev app status: run tasklist to find spawnbox processes, netstat for port 1420",
      type: "autonomy_recipe",
      tags: "dev-workflow,verification",
    });
    expect(recipe.stored).toBe(true);
    expect(recipe.note_id).toBeTruthy();

    // 3. Recall anti-patterns about editing files - should find the anti_pattern
    const recallAnti = handleRecall(projectDb, globalDb, {
      query: "editing files formatting",
      type: "anti_pattern",
    });
    expect(recallAnti.results.length).toBeGreaterThan(0);
    const foundAnti = recallAnti.results.find((r) =>
      r.content.includes("sed")
    );
    expect(foundAnti).toBeTruthy();
    expect(foundAnti!.type).toBe("anti_pattern");

    // 4. Recall autonomy recipes about dev app status - should find the recipe
    const recallRecipe = handleRecall(projectDb, globalDb, {
      query: "dev app status spawnbox",
      type: "autonomy_recipe",
    });
    expect(recallRecipe.results.length).toBeGreaterThan(0);
    const foundRecipe = recallRecipe.results.find((r) =>
      r.content.includes("tasklist")
    );
    expect(foundRecipe).toBeTruthy();
    expect(foundRecipe!.type).toBe("autonomy_recipe");
  });
});

describe("hybrid search + session tracking integration", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
  });

  // Helper to insert a note with a mock embedding vector
  function insertNoteWithEmbedding(
    content: string,
    type: string,
    vector: Float32Array
  ): string {
    const id = generateId();
    const ts = now();
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, last_validated, resolved, created_at, updated_at, access_count)
       VALUES (?, ?, ?, '', 'medium', ?, 0, ?, ?, 0)`,
      [id, type, content, ts, ts, ts]
    );
    const blob = Buffer.from(vector.buffer);
    db.run(
      `INSERT INTO embeddings (note_id, vector, model, embedded_at) VALUES (?, ?, ?, ?)`,
      [id, blob, "bge-m3", ts]
    );
    return id;
  }

  test("hybrid search finds notes via both FTS5 and vector paths", async () => {
    // Insert notes - broker note has matching keywords AND similar vector
    const vec1 = new Float32Array(768).fill(0.5);
    const vec2 = new Float32Array(768).fill(0.3);
    insertNoteWithEmbedding(
      "broker convention for data retrieval",
      "convention",
      vec1
    );
    insertNoteWithEmbedding(
      "combat detection algorithm design",
      "decision",
      vec2
    );

    const queryVec = new Float32Array(768).fill(0.5);
    const results = await findRelatedNotesHybrid(db, "broker", 10, queryVec);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("broker");
  });

  test("activation tracking increments access_count", () => {
    const vec = new Float32Array(768).fill(0.5);
    const id = insertNoteWithEmbedding(
      "test note for activation",
      "insight",
      vec
    );

    const before = db
      .query(`SELECT access_count FROM notes WHERE id = ?`)
      .get(id) as any;
    expect(before.access_count).toBe(0);

    db.run(
      `UPDATE notes SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      [new Date().toISOString(), id]
    );

    const after = db
      .query(`SELECT access_count FROM notes WHERE id = ?`)
      .get(id) as any;
    expect(after.access_count).toBe(1);
  });

  test("session tracker annotates already-sent notes correctly", () => {
    const tracker = new SessionTracker(db);
    tracker.registerSession("test-session");

    const vec = new Float32Array(768).fill(0.5);
    const noteId = insertNoteWithEmbedding(
      "test convention note",
      "convention",
      vec
    );

    // First delivery
    tracker.logSurfaced("test-session", noteId, 1, "fresh");

    // Check annotation at turn 5
    const annotation = tracker.annotateResult("test-session", noteId, 5);
    expect(annotation.already_sent).toBe(true);
    expect(annotation.sent_turns_ago).toBe(4); // turn 5 - turn 1

    // Check a note that was NOT surfaced
    const otherId = insertNoteWithEmbedding("other note", "insight", vec);
    const otherAnnotation = tracker.annotateResult(
      "test-session",
      otherId,
      5
    );
    expect(otherAnnotation.already_sent).toBe(false);
    expect(otherAnnotation.sent_turns_ago).toBeNull();
  });

  test("cross-session annotation shows other sessions", () => {
    const tracker = new SessionTracker(db);
    tracker.registerSession("session-a");
    tracker.registerSession("session-b");

    const vec = new Float32Array(768).fill(0.5);
    const noteId = insertNoteWithEmbedding(
      "shared knowledge",
      "decision",
      vec
    );

    // Session A surfaces this note
    tracker.logSurfaced("session-a", noteId, 1, "fresh");

    // Session B checks - should see session-a surfaced it
    const annotation = tracker.annotateResult("session-b", noteId, 1);
    expect(annotation.already_sent).toBe(false); // not sent in session-b
    expect(annotation.sent_to_other_sessions.length).toBe(1);
    expect(annotation.sent_to_other_sessions[0].session_id).toBe("session-a");
  });
});
