import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { SessionTracker } from "../../mcp/engine/session_tracker";

describe("SessionTracker", () => {
  let db: Database;
  let tracker: SessionTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
    tracker = new SessionTracker(db);
  });

  test("registerSession creates a new session", () => {
    tracker.registerSession("sess-1");
    const session = tracker.getSession("sess-1");
    expect(session).not.toBeNull();
    expect(session!.session_id).toBe("sess-1");
  });

  test("logSurfaced tracks which notes were sent", () => {
    tracker.registerSession("sess-1");
    tracker.logSurfaced("sess-1", "note-1", 1, "fresh");
    tracker.logSurfaced("sess-1", "note-2", 1, "fresh");
    const sent = tracker.getNotesSurfaced("sess-1");
    expect(sent.size).toBe(2);
    expect(sent.has("note-1")).toBe(true);
  });

  test("annotateResult marks already-sent notes", () => {
    tracker.registerSession("sess-1");
    tracker.logSurfaced("sess-1", "note-1", 1, "fresh");
    // Need a note in the notes table for signal
    const ts = new Date().toISOString();
    db.run(`INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at) VALUES (?, ?, ?, '', 'medium', 0, ?, ?)`,
      ["note-1", "insight", "test", ts, ts]);

    const annotation = tracker.annotateResult("sess-1", "note-1", 5);
    expect(annotation.already_sent).toBe(true);
    expect(annotation.sent_turns_ago).toBe(4);
  });

  test("annotateResult shows not-sent for fresh notes", () => {
    tracker.registerSession("sess-1");
    const ts = new Date().toISOString();
    db.run(`INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at) VALUES (?, ?, ?, '', 'medium', 0, ?, ?)`,
      ["note-2", "insight", "test", ts, ts]);

    const annotation = tracker.annotateResult("sess-1", "note-2", 1);
    expect(annotation.already_sent).toBe(false);
    expect(annotation.sent_turns_ago).toBeNull();
  });

  test("nextTurn increments per-session counter", () => {
    expect(tracker.nextTurn("s1")).toBe(1);
    expect(tracker.nextTurn("s1")).toBe(2);
    expect(tracker.nextTurn("s2")).toBe(1); // different session
  });

  test("cleanup removes old sessions", () => {
    db.run(`INSERT INTO session_registry (session_id, started_at, last_active_at) VALUES (?, ?, ?)`,
      ["old-sess", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z"]);
    db.run(`INSERT INTO session_log (id, session_id, note_id, surfaced_at, turn_number, delivery_type) VALUES (?, ?, ?, ?, ?, ?)`,
      ["log-1", "old-sess", "note-1", "2020-01-01T00:00:00Z", 1, "fresh"]);

    tracker.cleanup();
    expect(tracker.getSession("old-sess")).toBeNull();
    const logs = db.query(`SELECT * FROM session_log WHERE session_id = ?`).all("old-sess");
    expect(logs.length).toBe(0);
  });

  test("setConciergeAgentId and getConciergeAgentId", () => {
    tracker.registerSession("sess-1");
    tracker.setConciergeAgentId("sess-1", "agent-abc123");
    expect(tracker.getConciergeAgentId("sess-1")).toBe("agent-abc123");
  });

  test("getCrossSessionUpdates surfaces notes from other active sessions", () => {
    const ts = new Date().toISOString();

    // Two sessions. Sibling created notes in the past, then the caller calls
    // briefing for the first time and should see them as 'new'.
    tracker.registerSession("caller");
    tracker.registerSession("sibling");

    // Sibling creates two notes
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at, source_session)
       VALUES (?, ?, ?, '', 'medium', 0, ?, ?, ?)`,
      ["note-a", "decision", "sibling decided foo", ts, ts, "sibling"]
    );
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at, source_session)
       VALUES (?, ?, ?, '', 'medium', 0, ?, ?, ?)`,
      ["note-b", "anti_pattern", "sibling found bar", ts, ts, "sibling"]
    );

    // Caller's own notes should NOT appear
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at, source_session)
       VALUES (?, ?, ?, '', 'medium', 0, ?, ?, ?)`,
      ["note-self", "insight", "my own thought", ts, ts, "caller"]
    );

    const updates = tracker.getCrossSessionUpdates("caller");
    expect(updates.active_session_count).toBe(1);
    expect(updates.new_notes.length).toBe(2);
    const ids = updates.new_notes.map((n) => n.id).sort();
    expect(ids).toEqual(["note-a", "note-b"]);
  });

  test("getCrossSessionUpdates respects last_briefing_at cursor", () => {
    const long_ago = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    tracker.registerSession("caller");
    tracker.registerSession("sibling");

    // Sibling created a note a long time ago (before the cursor we're about to set)
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at, source_session)
       VALUES (?, ?, ?, '', 'medium', 0, ?, ?, ?)`,
      ["note-old", "decision", "ancient history", long_ago, long_ago, "sibling"]
    );

    // Advance the caller's last_briefing_at cursor to an hour ago
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.run(
      `UPDATE session_registry SET last_briefing_at = ? WHERE session_id = ?`,
      [oneHourAgo, "caller"]
    );

    // Sibling creates a new note AFTER the cursor
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at, source_session)
       VALUES (?, ?, ?, '', 'medium', 0, ?, ?, ?)`,
      ["note-new", "insight", "fresh finding", recent, recent, "sibling"]
    );

    const updates = tracker.getCrossSessionUpdates("caller");
    const ids = updates.new_notes.map((n) => n.id);
    expect(ids).toContain("note-new");
    expect(ids).not.toContain("note-old");
  });

  test("updateLastBriefing advances the cursor", () => {
    tracker.registerSession("sess-1");
    const before = tracker.getSession("sess-1");
    expect(before?.last_briefing_at).toBeNull();
    tracker.updateLastBriefing("sess-1");
    const after = tracker.getSession("sess-1");
    expect(after?.last_briefing_at).not.toBeNull();
  });

  test("updateLastBriefing respects explicit timestamp (C2 race fix)", () => {
    tracker.registerSession("sess-1");
    const ts = "2026-01-15T12:00:00.000Z";
    tracker.updateLastBriefing("sess-1", ts);
    const row = tracker.getSession("sess-1");
    expect(row?.last_briefing_at).toBe(ts);
  });

  test("annotateResult hot_across_sessions counts other-session surfacings in last 2h", () => {
    const ts = new Date().toISOString();
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES (?, ?, ?, '', 'medium', 0, ?, ?)`,
      ["hot-note", "decision", "hot topic", ts, ts]
    );

    tracker.registerSession("me");
    tracker.registerSession("sibling-a");
    tracker.registerSession("sibling-b");
    tracker.registerSession("sibling-c");

    // Three sibling sessions each surface the note recently
    tracker.logSurfaced("sibling-a", "hot-note", 1, "fresh");
    tracker.logSurfaced("sibling-b", "hot-note", 1, "fresh");
    tracker.logSurfaced("sibling-c", "hot-note", 1, "fresh");

    // My own surfacing shouldn't count
    tracker.logSurfaced("me", "hot-note", 1, "fresh");

    const ann = tracker.annotateResult("me", "hot-note", 2);
    expect(ann.hot_across_sessions).toBe(3);
  });

  test("annotateResult hot_across_sessions ignores surfacings older than 2h", () => {
    const ts = new Date().toISOString();
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES (?, ?, ?, '', 'medium', 0, ?, ?)`,
      ["cold-note", "decision", "cold topic", ts, ts]
    );

    tracker.registerSession("me");
    tracker.registerSession("sibling-old");

    // Insert a stale session_log row 3 hours ago, bypassing logSurfaced which
    // always uses now()
    const threeHoursAgo = new Date(
      Date.now() - 3 * 60 * 60 * 1000
    ).toISOString();
    db.run(
      `INSERT INTO session_log (id, session_id, note_id, surfaced_at, turn_number, delivery_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["log-old", "sibling-old", "cold-note", threeHoursAgo, 1, "fresh"]
    );

    const ann = tracker.annotateResult("me", "cold-note", 1);
    expect(ann.hot_across_sessions).toBe(0);
    // But the 7-day sent_to_other_sessions SHOULD still see it
    expect(ann.sent_to_other_sessions.length).toBe(1);
  });

  test("getCrossSessionUpdates upperBound prevents the cursor race (C2)", () => {
    tracker.registerSession("caller");
    tracker.registerSession("sibling");

    const early = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cutoff = new Date().toISOString();
    const late = new Date(Date.now() + 60 * 1000).toISOString();

    // A note created before the cutoff - should appear
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at, source_session)
       VALUES (?, ?, ?, '', 'medium', 0, ?, ?, ?)`,
      ["note-early", "insight", "before cutoff", early, early, "sibling"]
    );

    // A note created after the cutoff - should be excluded
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at, source_session)
       VALUES (?, ?, ?, '', 'medium', 0, ?, ?, ?)`,
      ["note-late", "insight", "after cutoff", late, late, "sibling"]
    );

    const updates = tracker.getCrossSessionUpdates("caller", cutoff);
    const ids = updates.new_notes.map((n) => n.id);
    expect(ids).toContain("note-early");
    expect(ids).not.toContain("note-late");
  });
});
