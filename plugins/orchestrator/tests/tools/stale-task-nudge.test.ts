import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import {
  renderCompactRoster,
  describeStaleTaskDeclaration,
  type CompactPeer,
} from "../../mcp/tools/hook_event";

// WI 7844a909 + e3a58e10.
//
// Jarid: "are you planning to somehow address the fact that agents don't
// maintain their running notes/records like they should?"
//
// NAGGING HAS ALREADY FAILED, WITH EVIDENCE. The plugin injects a housekeeping
// reminder on EVERY turn, and under that regime PA's own declared task went TWO
// DAYS stale - describing 0.44.x work while the fleet ran 0.56.0. More volume
// is not the lever; a nudge that is TRUE OF THE READER when it appears is. An
// always-applicable nudge becomes chrome (anti_pattern 60f2fdc2), and chrome is
// skipped exactly when it finally matters.
//
// Researched 2026-08-10 against code.claude.com/docs/en/hooks: PreCompact
// CANNOT carry this - it is a synchronous decision point with no model turn
// before compaction, so an agent cannot act on a prompt delivered there (the
// plugin already learned this and made its PreCompact capture deterministic).
// `Stop` is the event that can, because the turn ends but the conversation
// continues.
//
// These tests EXERCISE the function against a real database. An earlier draft
// grep'd the source for its guard clauses, which is the same weak shape as the
// grep-test that once pinned a bug as spec (retired in 0.56.0) - it proves the
// text exists, not that the behaviour holds.

const SID = "11111111-2222-3333-4444-555555555555";

function seed(db: Database, taskAgeHours: number | null, task: string | null) {
  db.run(
    `INSERT OR REPLACE INTO session_registry
       (session_id, started_at, last_active_at, current_task, current_task_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      SID,
      new Date().toISOString(),
      new Date().toISOString(), // always FRESH - ordinary activity keeps bumping it
      task,
      taskAgeHours === null
        ? null
        : new Date(Date.now() - taskAgeHours * 3600_000).toISOString(),
    ]
  );
}

describe("stale-declaration nudge: fires when true, silent when not", () => {
  let db: Database;
  let ctx: any;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
    ctx = { db, tracker: null };
  });

  test("FIRES when the declaration is old", () => {
    seed(db, 30, "ORCH-IMP: shipped 0.44.0 + 0.44.1"); // the real PA failure, aged
    const out = describeStaleTaskDeclaration(ctx, SID);
    expect(out).not.toBe("");
    expect(out).toContain("update_session_task");
    expect(out).toContain("0.44.0"); // quotes the stale text back at the reader
  });

  test("SILENT when the declaration is fresh - the control that matters", () => {
    // If this ever fails, the nudge has become every-turn chrome and is worse
    // than nothing.
    seed(db, 0.25, "ORCH-IMP: currently fixing the roster");
    expect(describeStaleTaskDeclaration(ctx, SID)).toBe("");
  });

  test("SILENT when no task was ever declared", () => {
    // A different ask, already covered by the briefing; firing both would
    // double up on a session that has not started work yet.
    seed(db, null, null);
    expect(describeStaleTaskDeclaration(ctx, SID)).toBe("");
  });

  test("SILENT when the task predates the timestamp column", () => {
    // Migration 102 deliberately backfills nothing: a NULL means "set before we
    // tracked this", which cannot be dated and must not be guessed at.
    seed(db, null, "a task set before migration 102 existed");
    expect(describeStaleTaskDeclaration(ctx, SID)).toBe("");
  });

  test("age is reported in DAYS once it passes 24h", () => {
    seed(db, 49, "two days stale");
    expect(describeStaleTaskDeclaration(ctx, SID)).toContain("2d old");
  });

  test("an unknown session is silent, not an error", () => {
    expect(describeStaleTaskDeclaration(ctx, "no-such-session")).toBe("");
  });

  test("last_active_at CANNOT rescue it - that is why the column was added", () => {
    // The seed keeps last_active_at fresh on purpose. If the function read that
    // instead, a 30-hour-old declaration would look current and the nudge could
    // never fire - which is the bug that let PA drift for two days.
    seed(db, 30, "stale declaration, active session");
    expect(describeStaleTaskDeclaration(ctx, SID)).not.toBe("");
  });
});

describe("WI e3a58e10: liveness reaches the roster PA rebuilds from", () => {
  test("a SUSPECT peer is flagged", () => {
    const peers: CompactPeer[] = [
      { id8: "aaaaaaaa", current_task: "FIXER lane", liveness_state: "ingress_suspect" },
    ];
    const out = renderCompactRoster(peers);
    expect(out).toContain("[ingress_suspect]");
    expect(out).toContain("FIXER lane");
  });

  test("a HEALTHY peer is NOT annotated - absence means reachable", () => {
    // Printing "healthy" on every line trains the reader to skip the column,
    // which is exactly when the one suspect line gets missed.
    const peers: CompactPeer[] = [
      { id8: "bbbbbbbb", current_task: "CREATOR lane", liveness_state: "healthy" },
    ];
    const out = renderCompactRoster(peers);
    expect(out).not.toContain("[healthy]");
    expect(out).toContain("CREATOR lane");
  });

  test("null liveness degrades to the previous rendering", () => {
    // Every session predating this ships NULL here.
    const peers: CompactPeer[] = [{ id8: "cccccccc", current_task: "VMTEST" }];
    expect(renderCompactRoster(peers)).toBe("  - SA-cccccccc: VMTEST");
  });

  test("the client-transport state surfaces, task or no task", () => {
    const peers: CompactPeer[] = [
      { id8: "dddddddd", current_task: null, liveness_state: "client_transport_suspect" },
    ];
    const out = renderCompactRoster(peers);
    expect(out).toContain("[client_transport_suspect]");
    expect(out).toContain("(no task set)");
  });
});
