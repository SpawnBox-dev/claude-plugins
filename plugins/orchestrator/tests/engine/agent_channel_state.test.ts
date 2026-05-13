// Force :memory: DB path for tests BEFORE the module loads. bun:sqlite on
// Windows holds the .db file handle for an indefinite window after
// Database.close() returns, which trips EBUSY in rmSync test teardown.
// `:memory:` DBs have no file to lock; per-stateDir cache key still isolates
// each test. Production retains file-backed DBs via the default.
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readSessions,
  writeSession,
  removeSession,
  readOverrideState,
  setSAPause,
  clearSAPause,
  setGlobalPause,
  clearGlobalPause,
  readOffsets,
  writeOffset,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "agent-channel-test-"));
});
function sleepSync(ms: number): void {
  // bun:sqlite + WAL + Windows: the OS holds WAL/SHM file handles briefly
  // after Database.close() returns. Without a small delay before rmSync,
  // teardown hits EBUSY. Atomics.wait on a fresh SharedArrayBuffer is the
  // canonical sync-sleep pattern in Bun. Production code never hits this
  // because process exit releases handles before the OS cares.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

afterEach(() => {
  closeAgentChannelDb(stateDir);
  // Poll rmSync with backoff until WAL/SHM locks release. 10 attempts × 100ms
  // = 1s max before giving up; usually first or second attempt succeeds.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(stateDir, { recursive: true, force: true });
      return;
    } catch {
      sleepSync(100);
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe("sessions.json", () => {
  test("empty initially", () => {
    expect(readSessions(stateDir)).toEqual([]);
  });

  test("writeSession + readSessions round-trip", () => {
    const sess: SessionEntry = {
      session_id: "abc12345-...",
      id8: "abc12345",
      role: "subordinate",
      name: "SA-test",
      started_at: "2026-05-09T18:00:00Z",
      last_heartbeat_at: "2026-05-09T18:00:00Z",
    };
    writeSession(stateDir, sess);
    expect(readSessions(stateDir)).toEqual([sess]);
  });

  test("writeSession upserts on session_id", () => {
    const sess1: SessionEntry = {
      session_id: "x",
      id8: "x",
      role: "subordinate",
      name: "v1",
      started_at: "a",
      last_heartbeat_at: "a",
    };
    writeSession(stateDir, sess1);
    const sess2 = { ...sess1, name: "v2", last_heartbeat_at: "b" };
    writeSession(stateDir, sess2);
    expect(readSessions(stateDir)).toEqual([sess2]);
  });

  test("removeSession by session_id", () => {
    writeSession(stateDir, {
      session_id: "x",
      id8: "x",
      role: "subordinate",
      name: "v",
      started_at: "a",
      last_heartbeat_at: "a",
    });
    removeSession(stateDir, "x");
    expect(readSessions(stateDir)).toEqual([]);
  });

  test("readSessions tolerates malformed file", () => {
    writeFileSync(join(stateDir, "sessions.json"), "{not json");
    expect(readSessions(stateDir)).toEqual([]);
  });
});

describe("state.json (overrides)", () => {
  test("empty initially - no global pause, no SA pauses", () => {
    const st = readOverrideState(stateDir);
    expect(st.pa_global_pause.active).toBe(false);
    expect(st.sa_pauses).toEqual({});
  });

  test("setSAPause + readOverrideState", () => {
    setSAPause(stateDir, "sa-uuid", "pa-uuid");
    const st = readOverrideState(stateDir);
    expect(st.sa_pauses["sa-uuid"]).toBeDefined();
    expect(st.sa_pauses["sa-uuid"].set_by_session).toBe("pa-uuid");
    expect(st.sa_pauses["sa-uuid"].since).toBeTruthy();
  });

  test("clearSAPause removes the pause entry", () => {
    setSAPause(stateDir, "sa-uuid", "pa-uuid");
    clearSAPause(stateDir, "sa-uuid");
    expect(readOverrideState(stateDir).sa_pauses).toEqual({});
  });

  test("setGlobalPause then clearGlobalPause", () => {
    setGlobalPause(stateDir, "pa-uuid");
    expect(readOverrideState(stateDir).pa_global_pause.active).toBe(true);
    clearGlobalPause(stateDir);
    expect(readOverrideState(stateDir).pa_global_pause.active).toBe(false);
  });
});

describe("offsets-<receiver>.json (per-instance)", () => {
  test("readOffsets empty initially", () => {
    expect(readOffsets(stateDir, "abc12345")).toEqual({});
  });

  test("writeOffset + readOffsets round-trip", () => {
    writeOffset(stateDir, "abc12345", "/path/to/file.jsonl", 1024);
    expect(readOffsets(stateDir, "abc12345")).toEqual({ "/path/to/file.jsonl": 1024 });
  });

  test("writeOffset overwrites previous value for same receiver", () => {
    writeOffset(stateDir, "abc12345", "/path/to/file.jsonl", 1024);
    writeOffset(stateDir, "abc12345", "/path/to/file.jsonl", 2048);
    expect(readOffsets(stateDir, "abc12345")).toEqual({ "/path/to/file.jsonl": 2048 });
  });

  test("offsets are isolated per receiver", () => {
    writeOffset(stateDir, "abc12345", "/path/to/file.jsonl", 1024);
    writeOffset(stateDir, "d4e5f6a7", "/path/to/file.jsonl", 9999);
    expect(readOffsets(stateDir, "abc12345")).toEqual({ "/path/to/file.jsonl": 1024 });
    expect(readOffsets(stateDir, "d4e5f6a7")).toEqual({ "/path/to/file.jsonl": 9999 });
  });
});
