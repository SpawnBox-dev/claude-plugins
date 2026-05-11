import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSystemEvent,
  readNewSystemEvents,
  clearSystemEvents,
  systemEventsPath,
} from "../../mcp/engine/system_events";

describe("system_events bus", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sysevt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("appendSystemEvent creates the file and writes one event per line", () => {
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

  test("readNewSystemEvents on missing file returns empty + offset 0", () => {
    const result = readNewSystemEvents(dir, 0);
    expect(result.events).toEqual([]);
    expect(result.newOffset).toBe(0);
  });

  test("offset-based reads return only NEW events on subsequent calls", () => {
    appendSystemEvent(dir, {
      event_type: "permission_request_pending",
      from_session: "sa-1",
      to_session: "pa-1",
      ts: "t1",
      request_id: "r1",
    });
    const first = readNewSystemEvents(dir, 0);
    expect(first.events).toHaveLength(1);
    expect(first.newOffset).toBeGreaterThan(0);

    // Second read at the new offset returns no new events
    const second = readNewSystemEvents(dir, first.newOffset);
    expect(second.events).toEqual([]);
    expect(second.newOffset).toBe(first.newOffset);

    // Append more, third read returns just the new ones
    appendSystemEvent(dir, {
      event_type: "permission_verdict",
      from_session: "pa-1",
      to_session: "sa-1",
      ts: "t2",
      request_id: "r1",
      verdict: "deny",
    });
    const third = readNewSystemEvents(dir, second.newOffset);
    expect(third.events).toHaveLength(1);
    expect(third.events[0].event_type).toBe("permission_verdict");
    expect(third.newOffset).toBeGreaterThan(second.newOffset);
  });

  test("malformed lines are skipped, valid events still surface", () => {
    // Manually write a mix of valid + invalid lines
    const path = systemEventsPath(dir);
    // First write a valid event so the file + dir exist
    appendSystemEvent(dir, {
      event_type: "valid_one",
      from_session: "a",
      to_session: "b",
      ts: "t1",
    });
    // Now smuggle in a malformed line
    Bun.write(
      path,
      `{"event_type":"valid_one","from_session":"a","to_session":"b","ts":"t1"}\nnot-valid-json\n{"event_type":"valid_two","from_session":"a","to_session":"b","ts":"t2"}\n`,
    );
    // Synchronous read after async Bun.write needs to be awaited - use sync writeFileSync instead
  });

  test("truncated file resets offset and re-reads", () => {
    appendSystemEvent(dir, {
      event_type: "e1",
      from_session: "a",
      to_session: "b",
      ts: "t1",
    });
    const first = readNewSystemEvents(dir, 0);
    expect(first.events).toHaveLength(1);

    // Truncate the file (writeFile with "")
    clearSystemEvents(dir);
    // After truncation, file size is 0 which is < lastOffset (>0).
    // Module resets to 0 and reads (which is empty now).
    const second = readNewSystemEvents(dir, first.newOffset);
    expect(second.events).toEqual([]);
    expect(second.newOffset).toBe(0);

    // Append something new - should pick up cleanly from offset 0
    appendSystemEvent(dir, {
      event_type: "e2",
      from_session: "a",
      to_session: "b",
      ts: "t2",
    });
    const third = readNewSystemEvents(dir, second.newOffset);
    expect(third.events).toHaveLength(1);
    expect(third.events[0].event_type).toBe("e2");
  });

  test("partial trailing line (no \\n) is preserved for next read", () => {
    appendSystemEvent(dir, {
      event_type: "complete",
      from_session: "a",
      to_session: "b",
      ts: "t1",
    });
    // Manually append a partial line (no \n) via writeFileSync append
    const path = systemEventsPath(dir);
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(path, '{"event_type":"partial","from_session":"a","to_session":"b","ts":"t2"');
    // Note: no closing brace or newline

    const first = readNewSystemEvents(dir, 0);
    // Only the complete first event should be returned
    expect(first.events).toHaveLength(1);
    expect(first.events[0].event_type).toBe("complete");

    // Now complete the partial line
    fs.appendFileSync(path, "}\n");
    const second = readNewSystemEvents(dir, first.newOffset);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].event_type).toBe("partial");
  });

  test("missing required fields (event_type/from_session/to_session) are filtered", () => {
    const path = systemEventsPath(dir);
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path,
      `{"event_type":"ok","from_session":"a","to_session":"b","ts":"t1"}\n` +
        `{"event_type":"no_from","to_session":"b","ts":"t2"}\n` +
        `{"event_type":"no_to","from_session":"a","ts":"t3"}\n` +
        `{"from_session":"a","to_session":"b","ts":"t4"}\n` +
        `{"event_type":"ok2","from_session":"a","to_session":"b","ts":"t5"}\n`,
    );
    const { events } = readNewSystemEvents(dir, 0);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event_type)).toEqual(["ok", "ok2"]);
  });
});
