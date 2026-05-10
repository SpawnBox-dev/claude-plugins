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
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "agent-channel-test-"));
});
afterEach(() => {
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

describe("offsets.json", () => {
  test("readOffsets empty initially", () => {
    expect(readOffsets(stateDir)).toEqual({});
  });

  test("writeOffset + readOffsets round-trip", () => {
    writeOffset(stateDir, "/path/to/file.jsonl", 1024);
    expect(readOffsets(stateDir)).toEqual({ "/path/to/file.jsonl": 1024 });
  });

  test("writeOffset overwrites previous value", () => {
    writeOffset(stateDir, "/path/to/file.jsonl", 1024);
    writeOffset(stateDir, "/path/to/file.jsonl", 2048);
    expect(readOffsets(stateDir)).toEqual({ "/path/to/file.jsonl": 2048 });
  });
});
