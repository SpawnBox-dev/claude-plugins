import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { findRelatedNotes } from "../../mcp/engine/linker";
import { handleOrient } from "../../mcp/tools/orient";
import { depositSignal } from "../../mcp/engine/signal";
import { now } from "../../mcp/utils";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

/** Insert a note directly (bypasses dedup) so the test controls all fields. */
function insertNote(
  db: Database,
  id: string,
  opts: {
    type: string;
    content: string;
    keywords?: string;
    tags?: string;
    confidence?: string;
    resolved?: number;
    status?: string | null;
    priority?: string | null;
    signal?: number;
    created_at?: string;
    updated_at?: string;
  }
): void {
  const ts = opts.created_at ?? now();
  db.run(
    `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, status, priority, created_at, updated_at, signal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.type,
      opts.content,
      opts.keywords ?? "",
      opts.tags ?? "",
      opts.confidence ?? "medium",
      opts.resolved ?? 0,
      opts.status ?? null,
      opts.priority ?? null,
      ts,
      opts.updated_at ?? ts,
      opts.signal ?? 0,
    ]
  );
}

describe("R3.2: signal influences ranking across retrieval surfaces", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("findRelatedNotes: hot note outranks cold note when BM25 scores are close", () => {
    // Two notes with identical content + keywords so BM25 scores are equal.
    // Insert cold FIRST to rule out insertion-order as the cause.
    insertNote(projectDb, "cold-note", {
      type: "decision",
      content: "event-driven architecture patterns for backend services",
      keywords: "event,driven,architecture,backend,services",
      confidence: "medium",
    });
    insertNote(projectDb, "hot-note", {
      type: "decision",
      content: "event-driven architecture patterns for backend services",
      keywords: "event,driven,architecture,backend,services",
      confidence: "medium",
    });
    // Hot note gets a large signal deposit.
    depositSignal(projectDb, "hot-note", 10.0);

    const results = findRelatedNotes(projectDb, "event-driven architecture");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Hot note should win when BM25 scores tie - signal boost tips it.
    expect(results[0].id).toBe("hot-note");
  });

  test("findRelatedNotes: high confidence outranks low confidence at equal BM25", () => {
    // Insert LOW confidence first to rule out insertion-order as the cause.
    insertNote(projectDb, "lo-conf", {
      type: "decision",
      content: "microservice event architecture",
      keywords: "microservice,event,architecture",
      confidence: "low",
    });
    insertNote(projectDb, "hi-conf", {
      type: "decision",
      content: "microservice event architecture",
      keywords: "microservice,event,architecture",
      confidence: "high",
    });

    const results = findRelatedNotes(projectDb, "microservice event");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].id).toBe("hi-conf");
  });

  test("composeBriefing openThreads: hot thread floats above cold thread at same update time", () => {
    const ts = now();
    // Insert cold FIRST so if ordering is signal-blind, cold would come first.
    insertNote(projectDb, "cold-thread", {
      type: "open_thread",
      content: "cold untouched question",
      keywords: "cold,thread",
      confidence: "medium",
      signal: 0,
      created_at: ts,
      updated_at: ts,
    });
    insertNote(projectDb, "hot-thread", {
      type: "open_thread",
      content: "hot question that agents keep surfacing",
      keywords: "hot,thread",
      confidence: "medium",
      signal: 5.0,
      created_at: ts,
      updated_at: ts,
    });

    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    const ids = result.briefing.open_threads.map((n) => n.id);
    expect(ids).toContain("hot-thread");
    expect(ids).toContain("cold-thread");
    expect(ids.indexOf("hot-thread")).toBeLessThan(ids.indexOf("cold-thread"));
  });

  test("composeBriefing activeWork: signal breaks tie within same priority", () => {
    const ts = now();
    // Insert cold FIRST to rule out insertion-order as the cause.
    insertNote(projectDb, "cold-wi", {
      type: "work_item",
      content: "cold active work item",
      keywords: "cold,work",
      confidence: "medium",
      status: "active",
      priority: "high",
      signal: 0,
      created_at: ts,
      updated_at: ts,
    });
    insertNote(projectDb, "hot-wi", {
      type: "work_item",
      content: "hot active work item",
      keywords: "hot,work",
      confidence: "medium",
      status: "active",
      priority: "high",
      signal: 10.0,
      created_at: ts,
      updated_at: ts,
    });

    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    const ids = result.briefing.active_work.map((n) => n.id);
    expect(ids).toContain("hot-wi");
    expect(ids).toContain("cold-wi");
    expect(ids.indexOf("hot-wi")).toBeLessThan(ids.indexOf("cold-wi"));
  });

  test("composeBriefing activeWork: critical priority still beats high priority regardless of signal", () => {
    const ts = now();
    // Insert the HIGH-priority hot note first; if signal were the only sort,
    // it would come first and the test would fail. Critical priority must
    // dominate regardless of signal.
    insertNote(projectDb, "high-hot", {
      type: "work_item",
      content: "very hot high priority",
      keywords: "high,hot",
      confidence: "medium",
      status: "active",
      priority: "high",
      signal: 100.0,
      created_at: ts,
      updated_at: ts,
    });
    insertNote(projectDb, "critical-cold", {
      type: "work_item",
      content: "cold critical priority",
      keywords: "critical,cold",
      confidence: "medium",
      status: "active",
      priority: "critical",
      signal: 0,
      created_at: ts,
      updated_at: ts,
    });

    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    const ids = result.briefing.active_work.map((n) => n.id);
    expect(ids).toContain("high-hot");
    expect(ids).toContain("critical-cold");
    // Critical must outrank High regardless of signal.
    expect(ids.indexOf("critical-cold")).toBeLessThan(ids.indexOf("high-hot"));
  });
});
