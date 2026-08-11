// See agent_channel_state.test.ts for why this must precede the import.
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import {
  writeSession,
  readSessions,
  setCurrentTask,
  closeAgentChannelDb,
} from "../../mcp/engine/agent_channel_state";
import { tickStaleTaskDeclaration } from "../../mcp/tools/hook_event";

// SA-d4db6493 non-author review of fe4d4acf / commit 3fac23f, HIGH finding:
//
//   "backfillRosterTask gates the refs repair on the TASK being missing, but
//    the two are lost together and restored separately... any route that
//    repopulates roster current_task before backfill runs permanently prevents
//    the refs repair."
//
// They derived it from reading the conditionals and explicitly asked for it to
// be confirmed by execution: "if the test passes I'm wrong and I want to know."
// This is that test.
//
// Their correction to the population matters too, and inverts the framing the
// WI had been using: this does NOT hit parked sessions (they never re-declare,
// so current_task stays NULL and both fields restore). It hits ACTIVE sessions
// that re-declare a task without citing refs - which is most declarations.

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
let projectRoot: string;
let stateDir: string;
let db: Database;
let ctx: any;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "backfill-test-"));
  stateDir = join(projectRoot, ".orchestrator-state", "agent-channel");
  mkdirSync(stateDir, { recursive: true });
  // getAgentChannelStateDir() requires the db file to EXIST on disk before it
  // will report the project as agent-channel-enabled; the real reads go to the
  // :memory: db keyed by stateDir.
  writeFileSync(join(stateDir, "agent_channel.db"), "");
  process.env.ORCHESTRATOR_PROJECT_ROOT = projectRoot;

  db = new Database(":memory:");
  applyMigrations(db, "project");
  ctx = { db, tracker: null };
});

afterEach(() => {
  closeAgentChannelDb(stateDir);
  delete process.env.ORCHESTRATOR_PROJECT_ROOT;
  try {
    rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    /* Windows may hold the handle briefly; tmpdir is disposable */
  }
});

function seedRegistry(task: string, refs: string[] | null, hot?: string) {
  const ts = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO session_registry
       (session_id, started_at, last_active_at, current_task, current_task_at, refs, hot_path_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [SID, ts, ts, task, ts, refs ? JSON.stringify(refs) : null, hot ?? null]
  );
}

function seedRosterRow() {
  writeSession(stateDir, {
    session_id: SID,
    id8: SID.slice(0, 8),
    role: "subordinate",
    name: "SA-test",
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  });
}

describe("backfill repairs each field on ITS OWN condition", () => {
  test("REGRESSION: refs restore when the task is ALREADY present", () => {
    // The exact sequence from the review: reload wipes the roster row, the
    // session re-declares a task WITHOUT refs (so declareSelf leaves roster refs
    // empty while setting current_task), and the durable refs copy survives.
    // Under the old gating the repair returned early forever.
    seedRegistry("a re-declared task", ["fe4d4acf", "dcc756ec"]);
    seedRosterRow();
    setCurrentTask(stateDir, SID, "a re-declared task"); // roster task present, refs empty

    tickStaleTaskDeclaration(ctx, SID);

    const mine = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(mine.refs).toEqual(["fe4d4acf", "dcc756ec"]);
  });

  test("hot_path_status restores independently too - PA reads this one", () => {
    seedRegistry("a re-declared task", null, "idle-available");
    seedRosterRow();
    setCurrentTask(stateDir, SID, "a re-declared task");

    tickStaleTaskDeclaration(ctx, SID);

    const mine = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(mine.hot_path_status).toBe("idle-available");
  });

  test("the task still repairs when IT is the missing one", () => {
    // The original repair must keep working - this is the parked-session path
    // the review correctly noted was never broken.
    seedRegistry("the durable task", ["aaaaaaaa"]);
    seedRosterRow(); // roster row exists with NO task

    tickStaleTaskDeclaration(ctx, SID);

    const mine = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(mine.current_task).toBe("the durable task");
    expect(mine.refs).toEqual(["aaaaaaaa"]);
  });

  test("an ALREADY-CORRECT roster row is not rewritten", () => {
    // Repairing what is already right would mean a cross-DB write on every
    // tick for every session, forever.
    seedRegistry("task", ["aaaaaaaa"]);
    seedRosterRow();
    setCurrentTask(stateDir, SID, "task");
    tickStaleTaskDeclaration(ctx, SID); // repairs refs
    const first = readSessions(stateDir).find((s) => s.session_id === SID)!;
    tickStaleTaskDeclaration(ctx, SID); // nothing left to do
    const second = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(second.refs).toEqual(first.refs);
    expect(second.current_task).toBe(first.current_task!);
  });

  test("no durable copy -> the roster keeps its empty set, nothing invented", () => {
    seedRegistry("task with no refs ever declared", null);
    seedRosterRow();
    setCurrentTask(stateDir, SID, "task with no refs ever declared");

    tickStaleTaskDeclaration(ctx, SID);

    const mine = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(mine.refs).toBeUndefined();
  });
});
