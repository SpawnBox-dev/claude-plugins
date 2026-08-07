import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { composeBriefing } from "../../mcp/engine/composer";
import { generateId } from "../../mcp/utils";

// ===========================================================================
// 0.43.3: "Recent Decisions" was ordered by SIGNAL, so it could never show a
// recent decision.
//
// R3.2's comment said "signal as SECONDARY sort so hot decisions surface above
// cold AT THE SAME CREATION TIME". The SQL did the inverse: signal primary,
// created_at as tiebreaker. The comment was right and the query was the
// outlier - server.ts orders work items with exactly the intended shape
// ("priority tier remains the primary sort; signal is the tiebreaker").
//
// WHY IT WAS STRUCTURAL RATHER THAN A BAD DAY: `signal` is REAL DEFAULT 0. A
// decision is born at zero and only accumulates by being surfaced. With signal
// primary, a new decision had to out-accumulate months of deposits to enter the
// top 5. MEASURED on the live project DB 2026-08-07: all five returned rows
// were from MARCH 2026, signal 66-71, while that morning's newly-minted
// decision (signal 0) was absent. Every briefing since March had shown
// preview-era decisions under a heading promising recency.
//
// HOW IT WAS FOUND, which is the transferable part: PA relied on briefing-push
// to deliver a fresh standing ruling to a future session, and then MEASURED
// whether it actually arrived. It had not. Reading the section could never have
// revealed this - the rows look exactly like decisions, because they are
// decisions. Only checking for a specific expected row against its absence
// exposes it. Same shape as the badge that rendered a hardcoded field: the
// output is well-formed and wrong.
// ===========================================================================

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

function addDecision(
  db: Database,
  opts: { content: string; created: string; signal?: number }
) {
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at, source_session, signal)
     VALUES (?, 'decision', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      generateId(), opts.content, null, "", "decision", "high",
      opts.created, opts.created, null, opts.signal ?? 0,
    ]
  );
}

describe("0.43.3: Recent Decisions honours the currency claim in its name", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("THE REAL CASE: a brand-new zero-signal decision outranks months-old hot ones", () => {
    // Signal values and dates taken from the live rows this was measured on.
    addDecision(projectDb, { content: "MARCH preview-era A", created: "2026-03-07T00:00:00.000Z", signal: 70.6 });
    addDecision(projectDb, { content: "MARCH preview-era B", created: "2026-03-23T00:00:00.000Z", signal: 70.3 });
    addDecision(projectDb, { content: "MARCH preview-era C", created: "2026-03-29T00:00:00.000Z", signal: 68.5 });
    addDecision(projectDb, { content: "MARCH preview-era D", created: "2026-03-23T00:00:00.000Z", signal: 66.5 });
    addDecision(projectDb, { content: "MARCH preview-era E", created: "2026-03-07T00:00:00.000Z", signal: 65.9 });
    addDecision(projectDb, { content: "TODAY the standing ruling", created: "2026-08-07T00:00:00.000Z", signal: 0 });

    const b = composeBriefing(projectDb, globalDb);
    expect(b.recent_decisions.length).toBe(5);
    // The whole point: it must be FIRST, not merely present.
    expect(b.recent_decisions[0].content).toContain("TODAY");
  });

  test("the pre-fix ordering is what it must never return again", () => {
    // A regression here is silent in every other way - the section still
    // renders five well-formed decisions. Only an explicit expectation about
    // WHICH ones catches it.
    addDecision(projectDb, { content: "old and hot", created: "2026-03-07T00:00:00.000Z", signal: 99 });
    addDecision(projectDb, { content: "new and cold", created: "2026-08-07T00:00:00.000Z", signal: 0 });

    const b = composeBriefing(projectDb, globalDb);
    expect(b.recent_decisions[0].content).toBe("new and cold");
    expect(b.recent_decisions[1].content).toBe("old and hot");
  });

  test("signal still breaks ties AT THE SAME CREATION TIME - R3.2's actual intent", () => {
    // The fix must not throw signal away; it demotes it to the tiebreaker the
    // comment always described.
    const same = "2026-08-07T12:00:00.000Z";
    addDecision(projectDb, { content: "same-time cold", created: same, signal: 1 });
    addDecision(projectDb, { content: "same-time hot", created: same, signal: 50 });

    const b = composeBriefing(projectDb, globalDb);
    expect(b.recent_decisions[0].content).toBe("same-time hot");
    expect(b.recent_decisions[1].content).toBe("same-time cold");
  });

  test("still caps at 5 - the budget discipline is unchanged", () => {
    for (let i = 0; i < 9; i++) {
      addDecision(projectDb, {
        content: `d${i}`,
        created: `2026-08-0${i + 1}T00:00:00.000Z`,
        signal: 0,
      });
    }
    const b = composeBriefing(projectDb, globalDb);
    expect(b.recent_decisions.length).toBe(5);
    // Newest five, newest first.
    expect(b.recent_decisions[0].content).toBe("d8");
    expect(b.recent_decisions[4].content).toBe("d4");
  });

  test("SWEEP: open_threads had the identical inversion and is fixed with it", () => {
    // Found by grepping for the same shape rather than waiting for a second
    // report - the 0.43.1 lesson, where the reported surface was not the
    // worst one. Measured live the same day: Open Threads returned five
    // threads last touched in MARCH (signal 74-99) while every July thread
    // (signal 0-3) was invisible. For a section answering "what is still
    // open", showing only the oldest five is close to inverted.
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at, source_session, signal)
       VALUES (?, 'open_thread', 'MARCH hot thread', NULL, '', 'thread', 'high', 0, ?, ?, NULL, 99)`,
      [generateId(), "2026-03-25T00:00:00.000Z", "2026-03-25T00:00:00.000Z"]
    );
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at, source_session, signal)
       VALUES (?, 'open_thread', 'JULY cold thread', NULL, '', 'thread', 'high', 0, ?, ?, NULL, 0)`,
      [generateId(), "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"]
    );

    const b = composeBriefing(projectDb, globalDb);
    expect(b.open_threads[0].content).toBe("JULY cold thread");
    expect(b.open_threads[1].content).toBe("MARCH hot thread");
  });

  test("SWEEP CONTROL: blocked_work KEEPS signal-primary, which is correct there", () => {
    // The sweep must not turn into a find-and-replace. blocked_work's comment
    // states signal-primary as deliberate intent - "hot blocked items surface
    // above cold so repeated attention bubbles stuck work to the top" - and it
    // makes no recency claim. Changing it would be cargo-culting this fix into
    // a place its reasoning does not reach. This test pins that distinction so
    // a later reader does not "finish the job".
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, created_at, updated_at, source_session, signal)
       VALUES (?, 'work_item', 'OLD but repeatedly hit', NULL, '', 'w', 'high', 0, 'blocked', ?, ?, NULL, 90)`,
      [generateId(), "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]
    );
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, created_at, updated_at, source_session, signal)
       VALUES (?, 'work_item', 'NEW and untouched', NULL, '', 'w', 'high', 0, 'blocked', ?, ?, NULL, 0)`,
      [generateId(), "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z"]
    );

    const b = composeBriefing(projectDb, globalDb);
    expect(b.blocked_work[0].content).toBe("OLD but repeatedly hit");
  });

  test("a NULL signal does not sink a recent decision", () => {
    // COALESCE guards the tiebreaker; recency must not depend on it at all.
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at, source_session, signal)
       VALUES (?, 'decision', ?, NULL, '', 'decision', 'high', 0, ?, ?, NULL, NULL)`,
      [generateId(), "null-signal today", "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z"]
    );
    addDecision(projectDb, { content: "old hot", created: "2026-03-07T00:00:00.000Z", signal: 88 });

    const b = composeBriefing(projectDb, globalDb);
    expect(b.recent_decisions[0].content).toBe("null-signal today");
  });
});
