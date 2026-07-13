// PA-coherence primitive - Phase 1: sessions-table coherence columns, the
// idempotent additive migration, and the heartbeat-preserves-coherence
// correctness point (writeSession must NOT clobber observer-written columns).
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import {
  writeSession,
  readSessions,
  closeAgentChannelDb,
  ensureColumns,
  setWarmContext,
  setSessionLiveness,
  setHotPathStatus,
  setKeepClean,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

let baseDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "coherence-"));
  stateDir = join(baseDir, "project", ".orchestrator-state", "agent-channel");
  mkdirSync(stateDir, { recursive: true });
});
afterEach(() => {
  closeAgentChannelDb(stateDir);
  rmSync(baseDir, { recursive: true, force: true });
});

function base(id8: string): SessionEntry {
  return {
    session_id: `${id8}-1234-5678-9abc-def012345678`,
    id8,
    role: "subordinate",
    name: `SA-${id8}`,
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  };
}

describe("ensureColumns - idempotent additive migration", () => {
  test("adds missing columns to a pre-existing (old-schema) table, and is a no-op on re-run", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, id8 TEXT);`);
    ensureColumns(db, "sessions", { warm_context: "TEXT", keep_clean: "INTEGER" });
    const cols1 = (db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols1).toContain("warm_context");
    expect(cols1).toContain("keep_clean");
    // Re-run must NOT throw (column already exists) and must not duplicate.
    expect(() => ensureColumns(db, "sessions", { warm_context: "TEXT", keep_clean: "INTEGER" })).not.toThrow();
    const cols2 = (db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols2.filter((c) => c === "warm_context").length).toBe(1);
    db.close();
  });
});

describe("coherence columns present + round-trip", () => {
  test("a fresh DB has the coherence columns and readSessions surfaces them", () => {
    const s = base("abc12345");
    writeSession(stateDir, s);
    setWarmContext(stateDir, s.session_id, ["egress-detection", "anonymizer.rs"]);
    setHotPathStatus(stateDir, s.session_id, "idle-available");
    setKeepClean(stateDir, s.session_id, true);
    const [row] = readSessions(stateDir).filter((r) => r.id8 === "abc12345");
    expect(row.warm_context).toEqual(["egress-detection", "anonymizer.rs"]);
    expect(row.hot_path_status).toBe("idle-available");
    expect(row.keep_clean).toBe(true);
  });
});

describe("heartbeat does NOT clobber observer-written coherence columns", () => {
  test("writeSession (a heartbeat) preserves warm_context / liveness / hot_path / keep_clean", () => {
    const s = base("abc12345");
    writeSession(stateDir, s);
    setWarmContext(stateDir, s.session_id, ["telemetry-broker"]);
    setSessionLiveness(stateDir, s.session_id, {
      state: "ingress_suspect",
      observedAt: "2026-07-13T18:00:00.000Z",
      ttlSeconds: 300,
    });
    setKeepClean(stateDir, s.session_id, true);
    // A heartbeat: same base entry, fresh timestamp, NO coherence fields on it.
    writeSession(stateDir, { ...s, last_heartbeat_at: "2026-07-13T18:00:30.000Z" });
    const [row] = readSessions(stateDir).filter((r) => r.id8 === "abc12345");
    expect(row.warm_context).toEqual(["telemetry-broker"]);
    expect(row.liveness_state).toBe("ingress_suspect");
    expect(row.keep_clean).toBe(true);
    expect(row.last_heartbeat_at).toBe("2026-07-13T18:00:30.000Z"); // base field DID update
  });
});

describe("setSessionLiveness - freshest-observation-wins + TTL", () => {
  test("a newer observation replaces an older; an older observation is ignored", () => {
    const s = base("abc12345");
    writeSession(stateDir, s);
    setSessionLiveness(stateDir, s.session_id, { state: "egress_suspect", observedAt: "2026-07-13T18:00:00.000Z", ttlSeconds: 300 });
    // Older observation -> ignored (freshest wins).
    setSessionLiveness(stateDir, s.session_id, { state: "healthy", observedAt: "2026-07-13T17:59:00.000Z" });
    let [row] = readSessions(stateDir).filter((r) => r.id8 === "abc12345");
    expect(row.liveness_state).toBe("egress_suspect");
    // Newer observation -> replaces.
    setSessionLiveness(stateDir, s.session_id, { state: "healthy", observedAt: "2026-07-13T18:01:00.000Z" });
    [row] = readSessions(stateDir).filter((r) => r.id8 === "abc12345");
    expect(row.liveness_state).toBe("healthy");
    expect(row.liveness_ts).toBe("2026-07-13T18:01:00.000Z");
  });

  test("a suspect state carries an expires_at (ttl); healthy does not", () => {
    const s = base("abc12345");
    writeSession(stateDir, s);
    setSessionLiveness(stateDir, s.session_id, { state: "ingress_suspect", observedAt: "2026-07-13T18:00:00.000Z", ttlSeconds: 120 });
    let [row] = readSessions(stateDir).filter((r) => r.id8 === "abc12345");
    expect(row.liveness_expires_at).toBe("2026-07-13T18:02:00.000Z");
    setSessionLiveness(stateDir, s.session_id, { state: "healthy", observedAt: "2026-07-13T18:03:00.000Z" });
    [row] = readSessions(stateDir).filter((r) => r.id8 === "abc12345");
    expect(row.liveness_expires_at ?? null).toBeNull();
  });
});
