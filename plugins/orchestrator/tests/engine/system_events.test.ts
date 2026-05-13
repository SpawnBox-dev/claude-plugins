// Force :memory: DB path before any module loads. bun:sqlite + WAL + Windows
// keeps file handles around after Database.close() returns and would break
// rmSync teardown. :memory: avoids the issue; per-stateDir cache key still
// isolates each test. (Same pattern as agent_channel_state.test.ts.)
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSystemEvent,
  readNewSystemEvents,
  clearSystemEvents,
  closeAgentChannelDb,
} from "../../mcp/engine/agent_channel_state";

/**
 * 0.30.36: system_events bus moved from append-only `system_events.jsonl`
 * with byte-offset bookkeeping to a SQLite table with auto-increment IDs.
 *
 * What's still tested:
 *  - append + read round-trip + ID-based pagination (replacing the prior
 *    byte-offset pagination)
 *  - clearSystemEvents wipes the table
 *  - missing required fields are rejected at INSERT time (event_type /
 *    from_session / to_session are NOT NULL in schema)
 *  - migration from legacy `system_events.jsonl` on first read
 *
 * What was REMOVED (no longer applicable under SQLite):
 *  - "partial trailing line preserved for next read" - INSERTs are atomic,
 *    there are no partial rows
 *  - "malformed lines skipped" via raw file writes - the legacy migration
 *    path handles malformed lines, but the live path takes only structured
 *    SystemEvent values, no raw text
 *  - "truncated file resets offset" - SQLite doesn't have file truncation
 *    semantics; clearSystemEvents() just executes DELETE
 */
describe("system_events bus (SQLite-backed, 0.30.36+)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sysevt-"));
  });
  afterEach(() => {
    closeAgentChannelDb(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  test("appendSystemEvent + readNewSystemEvents round-trip", () => {
    appendSystemEvent(dir, {
      event_type: "permission_request_pending",
      from_session: "sa-1",
      to_session: "pa-1",
      ts: new Date().toISOString(),
      request_id: "r1",
    });
    appendSystemEvent(dir, {
      event_type: "permission_verdict",
      from_session: "pa-1",
      to_session: "sa-1",
      ts: new Date().toISOString(),
      request_id: "r1",
      verdict: "allow",
    });
    const { events } = readNewSystemEvents(dir, 0);
    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe("permission_request_pending");
    expect(events[0].request_id).toBe("r1");
    expect(events[1].event_type).toBe("permission_verdict");
    expect(events[1].verdict).toBe("allow");
  });

  test("readNewSystemEvents on empty table returns [] + lastSeenId unchanged", () => {
    const result = readNewSystemEvents(dir, 0);
    expect(result.events).toEqual([]);
    expect(result.newSeenId).toBe(0);
  });

  test("ID-based reads return only NEW events on subsequent calls", () => {
    appendSystemEvent(dir, {
      event_type: "permission_request_pending",
      from_session: "sa-1",
      to_session: "pa-1",
      ts: "t1",
      request_id: "r1",
    });
    const first = readNewSystemEvents(dir, 0);
    expect(first.events).toHaveLength(1);
    expect(first.newSeenId).toBeGreaterThan(0);

    // Second read at the new seen-id returns no new events
    const second = readNewSystemEvents(dir, first.newSeenId);
    expect(second.events).toEqual([]);
    expect(second.newSeenId).toBe(first.newSeenId);

    // Append more, third read returns just the new ones
    appendSystemEvent(dir, {
      event_type: "permission_verdict",
      from_session: "pa-1",
      to_session: "sa-1",
      ts: "t2",
      request_id: "r1",
      verdict: "deny",
    });
    const third = readNewSystemEvents(dir, second.newSeenId);
    expect(third.events).toHaveLength(1);
    expect(third.events[0].event_type).toBe("permission_verdict");
    expect(third.newSeenId).toBeGreaterThan(second.newSeenId);
  });

  test("appendSystemEvent returns the assigned id", () => {
    const id1 = appendSystemEvent(dir, {
      event_type: "a",
      from_session: "x",
      to_session: "y",
      ts: "t1",
    });
    const id2 = appendSystemEvent(dir, {
      event_type: "b",
      from_session: "x",
      to_session: "y",
      ts: "t2",
    });
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBe(id1 + 1);
  });

  test("clearSystemEvents wipes the table", () => {
    appendSystemEvent(dir, {
      event_type: "e1",
      from_session: "a",
      to_session: "b",
      ts: "t1",
    });
    expect(readNewSystemEvents(dir, 0).events).toHaveLength(1);
    clearSystemEvents(dir);
    expect(readNewSystemEvents(dir, 0).events).toEqual([]);
  });

  test("legacy system_events.jsonl migrates to DB on first read + file is deleted", () => {
    // Use a non-:memory: stateDir for this test so the legacy file can sit
    // alongside the DB on disk. Override the env var for just this test.
    const prior = process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY;
    delete process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY;
    const fileDir = mkdtempSync(join(tmpdir(), "sysevt-migrate-"));
    try {
      const legacyPath = join(fileDir, "system_events.jsonl");
      writeFileSync(
        legacyPath,
        [
          `{"event_type":"e1","from_session":"sa","to_session":"pa","ts":"t1","payload_field":"p1"}`,
          `not-valid-json`, // malformed line - should be skipped
          `{"event_type":"e2","from_session":"sa","to_session":"pa","ts":"t2"}`,
          `{"event_type":"no_to","from_session":"sa","ts":"t3"}`, // missing to_session - skipped
          ``, // blank line - skipped
        ].join("\n") + "\n",
      );
      expect(existsSync(legacyPath)).toBe(true);

      const { events } = readNewSystemEvents(fileDir, 0);
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.event_type)).toEqual(["e1", "e2"]);
      expect(events[0].payload_field).toBe("p1");
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      closeAgentChannelDb(fileDir);
      // Windows file-lock backoff (bun:sqlite quirk on file-backed DBs)
      for (let i = 0; i < 10; i++) {
        try {
          rmSync(fileDir, { recursive: true, force: true });
          break;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
      if (prior !== undefined) {
        process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = prior;
      }
    }
  });
});
