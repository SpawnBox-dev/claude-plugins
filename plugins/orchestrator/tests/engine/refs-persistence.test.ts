// See agent_channel_state.test.ts for why this must precede the import.
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readSessions,
  writeSession,
  setRefs,
  removeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// WI dcc756ec storage half. `refs` is a PA-coherence column: written only by
// its dedicated setter and never by writeSession (a heartbeat). The tests that
// matter here are about what a heartbeat must NOT do - because the twin column
// current_task was silently erased by exactly that path, and the roster showed
// "(no task set)" fleet-wide until 0.57.0 caught it.

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "refs-test-"));
});
afterEach(() => {
  closeAgentChannelDb(stateDir);
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the handle briefly; the tmpdir is disposable */
  }
});

function seedSession(id: string): SessionEntry {
  const e: SessionEntry = {
    session_id: id,
    id8: id.slice(0, 8),
    role: "subordinate",
    name: "SA-test",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    last_heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
  };
  writeSession(stateDir, e);
  return e;
}

const SID = "aaaaaaaa-1111-2222-3333-444444444444";

describe("refs storage round-trip", () => {
  test("round-trips as a real array, not a JSON string", () => {
    seedSession(SID);
    setRefs(stateDir, SID, ["40d09574", "dcc756ec"]);
    const row = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(row.refs).toEqual(["40d09574", "dcc756ec"]);
  });

  test("A HEARTBEAT MUST NOT ERASE refs - the bug that hit current_task", () => {
    // writeSession neither inserts nor updates this column. If someone later
    // adds it to that statement without COALESCE, every session's pointers get
    // wiped every 30 seconds and the roster quietly empties out - the exact
    // shape of the failure this arc started with, which took two days to spot
    // because nothing errors when a column is silently blanked.
    seedSession(SID);
    setRefs(stateDir, SID, ["40d09574"]);

    writeSession(stateDir, {
      ...seedSession(SID),
      last_heartbeat_at: new Date().toISOString(),
    });

    const row = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(row.refs).toEqual(["40d09574"]);
  });

  test("absent refs stay ABSENT, not an empty array", () => {
    // Roundtrip discipline shared with warm_context: a column that was never
    // written must not surface as a value callers could mistake for "declared
    // nothing to cite".
    seedSession(SID);
    const row = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(row.refs).toBeUndefined();
  });

  test("re-declaring REPLACES the list rather than appending", () => {
    seedSession(SID);
    setRefs(stateDir, SID, ["aaaaaaaa", "bbbbbbbb"]);
    setRefs(stateDir, SID, ["cccccccc"]);
    const row = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(row.refs).toEqual(["cccccccc"]);
  });

  test("A RELOAD WIPES THE COHERENCE COLUMNS - this is why the repair must repeat", () => {
    // The measured cause of the 22:02Z fleet-wide blank roster. A plugin reload
    // removes the session row and the new process re-inserts it, so every
    // column that lives ONLY in the agent-channel store is lost: current_task,
    // warm_context, hot_path_status, and refs. Only current_task has a durable
    // copy (session_registry) and can therefore be repaired.
    //
    // This test documents the lifecycle rather than asserting it is desirable.
    // If a future change makes these columns survive a re-registration, this
    // fails and the repair logic can be simplified - that is a good failure.
    seedSession(SID);
    setRefs(stateDir, SID, ["40d09574"]);
    expect(readSessions(stateDir).find((s) => s.session_id === SID)!.refs).toEqual(["40d09574"]);

    // Simulate what a reload does: drop the row, re-register fresh.
    removeSession(stateDir, SID);
    seedSession(SID);

    const after = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(after.refs).toBeUndefined(); // gone, as on the live fleet
    expect(after.current_task).toBeUndefined();
  });

  test("an empty list is storable - 'I cite nothing now' must be expressible", () => {
    seedSession(SID);
    setRefs(stateDir, SID, ["aaaaaaaa"]);
    setRefs(stateDir, SID, []);
    const row = readSessions(stateDir).find((s) => s.session_id === SID)!;
    expect(row.refs).toEqual([]);
  });
});
