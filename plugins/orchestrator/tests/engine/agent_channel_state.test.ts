// Force :memory: DB path for tests BEFORE the module loads. bun:sqlite on
// Windows holds the .db file handle for an indefinite window after
// Database.close() returns, which trips EBUSY in rmSync test teardown.
// `:memory:` DBs have no file to lock; per-stateDir cache key still isolates
// each test. Production retains file-backed DBs via the default.
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
  utimesSync,
} from "fs";
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

describe("stale *.tmp.* atomic-write debris sweep (WI 603dc765)", () => {
  // The sweep is internal (not exported); it runs once per process per
  // stateDir off the getDb first-open path. readSessions() triggers getDb,
  // so it is the test vehicle. Each test gets a unique mkdtemp stateDir, so
  // the module-level once-per-process guard never collides across tests.
  const TEN_MIN_AGO = new Date(Date.now() - 10 * 60_000);

  test("sweeps pre-0.30.35 *.tmp.* older than the age floor, preserves fresh tmp + the SQLite DB files", () => {
    // Stale debris (mtime 10 min ago - older than the 5-min floor).
    const staleA = join(stateDir, "sessions.json.tmp.a1b2c3");
    const staleB = join(stateDir, "offsets-abc12345.json.tmp.d4e5f6");
    writeFileSync(staleA, "stale");
    writeFileSync(staleB, "stale");
    utimesSync(staleA, TEN_MIN_AGO, TEN_MIN_AGO);
    utimesSync(staleB, TEN_MIN_AGO, TEN_MIN_AGO);
    // A fresh tmp (just written - inside the age floor) must NOT be swept:
    // it could be a legitimate in-flight write from an old-version MCP.
    const freshTmp = join(stateDir, "sessions.json.tmp.fresh99");
    writeFileSync(freshTmp, "fresh");
    // Decoys that do NOT contain ".tmp." must never be touched - the live
    // SQLite DB + its WAL/SHM siblings.
    const dbFile = join(stateDir, "agent_channel.db");
    const walFile = join(stateDir, "agent_channel.db-wal");
    writeFileSync(dbFile, "db");
    writeFileSync(walFile, "wal");

    // Trigger getDb -> first-open -> sweepStaleTmpArtifacts.
    readSessions(stateDir);

    expect(existsSync(staleA)).toBe(false);
    expect(existsSync(staleB)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
    expect(existsSync(dbFile)).toBe(true);
    expect(existsSync(walFile)).toBe(true);
  });

  test("runs once per process per stateDir - debris created AFTER first open is not swept again", () => {
    // First open: no tmp files -> nothing to sweep, guard now armed.
    expect(readSessions(stateDir)).toEqual([]);
    // Stale debris appears AFTER the guard armed (e.g. an old-version MCP
    // raced one in). The once-per-process guard short-circuits, so a later
    // state call does NOT re-sweep - acceptable: next process start reclaims
    // it, and we never pay a readdir on the hot path.
    const lateStale = join(stateDir, "offsets-x.json.tmp.late01");
    writeFileSync(lateStale, "late");
    utimesSync(lateStale, TEN_MIN_AGO, TEN_MIN_AGO);
    readSessions(stateDir);
    expect(existsSync(lateStale)).toBe(true);
  });

  test("sweep is safe on a dir with no tmp artifacts (no throw)", () => {
    expect(() => readSessions(stateDir)).not.toThrow();
    expect(readSessions(stateDir)).toEqual([]);
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
