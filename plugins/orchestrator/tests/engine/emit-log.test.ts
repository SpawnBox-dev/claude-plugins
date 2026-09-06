import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  appendEmitLog,
  newEmitId,
  emitLogPath,
  EMIT_LOG_BASENAME,
} from "../../mcp/engine/agent_channel_emitlog";

// ===========================================================================
// WI 6cf7437a - THE EMIT LOG.
//
// This exists because a delivery failure had two causes that produced
// IDENTICAL evidence on every surface we had. The offsets table advances by
// bytes CONSUMED, and processEvent has paths that consume without emitting, so
// "the offset is past that line" never meant "we sent it". The receiver's
// queue-operation rows are equally blind: Claude Code writes `enqueue` only
// once its handler runs, so "we never sent it" and "we sent it and CC dropped
// it" both render as no row at all.
//
// So the load-bearing property is not that the log records emits - it is that
// `emit` and `sent` are SEPARATE records sharing an emit_id. One without the
// other is the whole diagnostic. A test that only checked "a line was written"
// would pass on a log that merged them and answered nothing.
// ===========================================================================

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "emitlog-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lines = () =>
  readFileSync(emitLogPath(dir), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe("emit ids", () => {
  test("are unique across a burst - the join key cannot collide", () => {
    // A burst is exactly the case that loses messages, so uniqueness has to
    // hold under back-to-back generation within a single millisecond, not just
    // across a leisurely loop.
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(newEmitId());
    expect(ids.size).toBe(5000);
  });

  test("survive Claude Code's meta-key and attribute rendering unchanged", () => {
    // CC drops meta keys failing /^[a-zA-Z_][a-zA-Z0-9_]*$/, and renders values
    // into a double-quoted XML-ish attribute. An id containing a quote or a
    // space would either break the tag or be unrecoverable by a reader.
    for (let i = 0; i < 200; i++) {
      expect(newEmitId()).toMatch(/^[a-z0-9-]+$/);
    }
    expect("emit_id").toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  });
});

describe("the two-record property that makes the log diagnostic", () => {
  test("emit and sent are separate records joined by emit_id", () => {
    const id = newEmitId();
    appendEmitLog(dir, {
      ts: "2026-09-06T01:00:00.000Z",
      event: "emit",
      emit_id: id,
      receiver_id8: "66e2a4f9",
      sender_id8: "28e29d5d",
      src_offset: 7152782,
      event_type: "assistant_text",
      content_len: 2624,
      targets: 1,
    });
    appendEmitLog(dir, {
      ts: "2026-09-06T01:00:00.010Z",
      event: "sent",
      emit_id: id,
      receiver_id8: "66e2a4f9",
    });

    const rows = lines();
    expect(rows).toHaveLength(2);
    expect(rows[0].event).toBe("emit");
    expect(rows[1].event).toBe("sent");
    expect(rows[0].emit_id).toBe(id);
    expect(rows[1].emit_id).toBe(id);
    // The byte offset is what lets a reader open the ORIGINATING line rather
    // than guess at it from a timestamp.
    expect(rows[0].src_offset).toBe(7152782);
  });

  test("an emit with no sent is distinguishable from an emit with one", () => {
    // THE ACTUAL DIAGNOSTIC. If these two cases were not separable the log
    // would be decoration.
    const delivered = newEmitId();
    const stranded = newEmitId();
    appendEmitLog(dir, { ts: "t1", event: "emit", emit_id: delivered, receiver_id8: "aaaaaaaa" });
    appendEmitLog(dir, { ts: "t2", event: "sent", emit_id: delivered, receiver_id8: "aaaaaaaa" });
    appendEmitLog(dir, { ts: "t3", event: "emit", emit_id: stranded, receiver_id8: "aaaaaaaa" });

    const rows = lines();
    const sentIds = new Set(rows.filter((r) => r.event === "sent").map((r) => r.emit_id));
    const emitted = rows.filter((r) => r.event === "emit").map((r) => r.emit_id);
    const withoutSend = emitted.filter((id) => !sentIds.has(id));

    expect(withoutSend).toEqual([stranded]);
  });

  test("send_failed carries the transport error, so a failure is not silent", () => {
    const id = newEmitId();
    appendEmitLog(dir, {
      ts: "t",
      event: "send_failed",
      emit_id: id,
      receiver_id8: "aaaaaaaa",
      detail: "Not connected",
    });
    expect(lines()[0].detail).toBe("Not connected");
  });
});

describe("the producer-side drop paths are named, not silent", () => {
  test("unknown_sender records the offset it consumed without routing", () => {
    // This is the one path where the offset advances past a line that produced
    // nothing - previously indistinguishable from a successful emit.
    appendEmitLog(dir, {
      ts: "t",
      event: "unknown_sender",
      receiver_id8: "66e2a4f9",
      sender_id8: "28e29d5d",
      src_offset: 4242,
      detail: "sender absent from the fresh roster at routing time",
    });
    const r = lines()[0];
    expect(r.event).toBe("unknown_sender");
    expect(r.src_offset).toBe(4242);
    // No emit_id: nothing was ever handed to the transport, and inventing one
    // would imply a notification that never existed.
    expect(r.emit_id).toBeUndefined();
  });

  test("paragraph_filtered is recorded for an addressed message that vanishes", () => {
    appendEmitLog(dir, {
      ts: "t",
      event: "paragraph_filtered",
      receiver_id8: "28e29d5d",
      sender_id8: "66e2a4f9",
      event_type: "assistant_text",
      content_len: 900,
    });
    expect(lines()[0].event).toBe("paragraph_filtered");
  });
});

describe("robustness - diagnostics must never disturb routing", () => {
  test("a write into a nonexistent directory throws nothing", () => {
    // agent_channel calls this from inside the tick loop. An uncaught throw
    // in a setInterval callback silently halts the interval for the life of
    // the session (open_thread 6fb3b978) - so swallowing here is load-bearing,
    // not laziness.
    expect(() =>
      appendEmitLog(join(dir, "does", "not", "exist"), {
        ts: "t",
        event: "emit",
        receiver_id8: "aaaaaaaa",
      }),
    ).not.toThrow();
  });

  test("every record is one line, so a partial write cannot corrupt its neighbours", () => {
    appendEmitLog(dir, {
      ts: "t",
      event: "emit",
      receiver_id8: "aaaaaaaa",
      detail: "a detail with\nan embedded newline and a \"quote\"",
    });
    appendEmitLog(dir, { ts: "t", event: "sent", receiver_id8: "aaaaaaaa" });
    const raw = readFileSync(emitLogPath(dir), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    expect(lines()[0].detail).toContain("\n");
  });

  test("rotates instead of growing without bound, and keeps exactly one old file", () => {
    // An unbounded diagnostic file in a shared project directory is its own
    // defect. Assert the ROTATION HAPPENED (a .1 exists and the live file
    // shrank), not merely that the live file is small - the latter would also
    // pass if the log had simply been deleted.
    const path = emitLogPath(dir);
    writeFileSync(path, "x".repeat(5 * 1024 * 1024));
    const before = statSync(path).size;

    appendEmitLog(dir, { ts: "t", event: "emit", receiver_id8: "aaaaaaaa" });

    expect(existsSync(path + ".1")).toBe(true);
    expect(statSync(path).size).toBeLessThan(before);
    expect(lines()).toHaveLength(1);

    // A second rotation must not accumulate .2, .3, ...
    writeFileSync(path, "x".repeat(5 * 1024 * 1024));
    appendEmitLog(dir, { ts: "t", event: "emit", receiver_id8: "aaaaaaaa" });
    expect(existsSync(path + ".2")).toBe(false);
  });

  test("the log lands in the state dir under the documented name", () => {
    expect(emitLogPath("/some/dir")).toContain(EMIT_LOG_BASENAME);
  });
});
