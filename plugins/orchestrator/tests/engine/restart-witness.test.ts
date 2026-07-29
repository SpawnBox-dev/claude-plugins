import { describe, test, expect } from "bun:test";
import {
  lastCleanShutdownMs,
  restartExplainsSilence,
  readLifecycleTail,
  RESTART_WINDOW_MS,
} from "../../mcp/engine/restart_witness";

// ===========================================================================
// 0.41.0: the alert asked a question the log could answer.
//
// Both liveness alerts carry a triage step meaning "did anything just restart
// the MCP servers? Then expect this and wait it out." Correct discriminator,
// addressed to a reader who cannot see a reload run in someone else's
// terminal. The restart record can.
//
// COST THAT PROMPTED IT (2026-07-29): a rolling /plugin update across seven
// sessions produced a benign egress_suspect one second into each process
// handoff. The first pulled four sessions into transcript sampling and
// 45-second re-reads to establish what the log states outright - with four
// more reloads still queued.
//
// THE DIRECTION IS THE WHOLE DESIGN (PA-d4c8dda8): key on the BENIGN-case
// signal to SUPPRESS, never on the failure-case signal to ALERT. A clean
// shutdown writes a line; an egress death writes nothing - PA's 58-minute
// outage had neither a shutdown nor a start line, just a live process with a
// severed transport. So absence falls through to alerting, which fails SAFE.
// Keying on the failure signal would fail SILENT, going quiet exactly when it
// mattered. Same reason readLifecycleTail returns "" on error.
//
// AND THE PARSER DEFECT THESE TESTS EXIST TO PREVENT: the first version keyed
// on `MCP server starting`, which carries NO TIMESTAMP - measured against the
// real log, 0 of 34 start lines have an `at=` field while 23 of 23 shutdown
// lines do. It would have returned null forever: a suppressor that cannot
// suppress, which is exactly the 0.37.0 shape. It was caught because a
// handoff-gap measurement came back empty and the emptiness did not add up.
// ===========================================================================

const SID = "4e3d2623-819a-4c4c-a66c-6212c3a5faf1";

// Real lines, copied verbatim from mcp-lifecycle.log.
const REAL_SHUTDOWN =
  "[orchestrator] shutdown triggered=stdin-end at=2026-07-29T17:04:44.249Z pid=51624 uptime_sec=7419 session_id=" +
  SID;
const REAL_START =
  "[orchestrator] MCP server starting - version=0.40.0 pid=49480 session_id=" +
  SID +
  " project_dir=C:\\Users\\Jarid\\OneDrive\\AppDev\\mc-server-project\\spawnbox role=subordinate";

describe("0.41.0: lastCleanShutdownMs", () => {
  test("finds a real shutdown line and its timestamp", () => {
    expect(lastCleanShutdownMs(REAL_SHUTDOWN, SID)).toBe(
      Date.parse("2026-07-29T17:04:44.249Z")
    );
  });

  test("REGRESSION: a start line alone yields null - it has no timestamp", () => {
    // The defect. If someone re-keys this on `MCP server starting`, this test
    // documents why that cannot work: the line carries no `at=` field at all.
    expect(REAL_START).not.toContain("at=");
    expect(lastCleanShutdownMs(REAL_START, SID)).toBeNull();
  });

  test("ignores other sessions' shutdowns", () => {
    const other = REAL_SHUTDOWN.replace(SID, "d4c8dda8-80e2-4427-8588-8f4f979a2120");
    expect(lastCleanShutdownMs(other, SID)).toBeNull();
  });

  test("returns the MOST RECENT when several exist", () => {
    const older = REAL_SHUTDOWN.replace("17:04:44.249", "15:04:44.249");
    expect(lastCleanShutdownMs(`${older}\n${REAL_SHUTDOWN}`, SID)).toBe(
      Date.parse("2026-07-29T17:04:44.249Z")
    );
    // Order in the file must not matter.
    expect(lastCleanShutdownMs(`${REAL_SHUTDOWN}\n${older}`, SID)).toBe(
      Date.parse("2026-07-29T17:04:44.249Z")
    );
  });

  test("survives junk without throwing - it must not break the detector", () => {
    expect(lastCleanShutdownMs("", SID)).toBeNull();
    expect(lastCleanShutdownMs("garbage\n\nshutdown triggered=x at=nonsense " + SID, SID)).toBeNull();
  });
});

describe("0.41.0: restartExplainsSilence", () => {
  const now = Date.parse("2026-07-29T17:04:45.000Z");

  test("THE REAL FIRING: a shutdown 0.75s earlier explains it", () => {
    // egress_suspect fired at 17:04:45, the shutdown was logged at 17:04:44.249.
    expect(restartExplainsSilence(Date.parse("2026-07-29T17:04:44.249Z"), now)).toBe(true);
  });

  test("FAILS SAFE: no shutdown record means ALERT, not suppress", () => {
    // The load-bearing case. PA's 58-minute outage wrote no shutdown line, so
    // absence must fall through to alerting. If this ever returns true, the
    // suppressor has become a blindfold.
    expect(restartExplainsSilence(null, now)).toBe(false);
  });

  test("an OLD shutdown does not explain a fresh silence", () => {
    expect(restartExplainsSilence(now - RESTART_WINDOW_MS - 1, now)).toBe(false);
  });

  test("boundary is exact", () => {
    expect(restartExplainsSilence(now - RESTART_WINDOW_MS + 1, now)).toBe(true);
    expect(restartExplainsSilence(now - RESTART_WINDOW_MS, now)).toBe(false);
  });

  test("clock skew (future timestamp) is treated as in-window, not as negative age", () => {
    // A future `at=` would otherwise produce a negative age that quietly fails
    // the comparison and un-suppresses a genuine restart.
    expect(restartExplainsSilence(now + 30_000, now)).toBe(true);
  });

  test("the window is short enough that a broken post-restart session still alerts", () => {
    // Bounded residual, stated rather than hidden: a session that restarts AND
    // returns with dead egress is suppressed only for this long.
    expect(RESTART_WINDOW_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

describe("0.41.0: readLifecycleTail fails OPEN", () => {
  test("a missing file returns empty, which alerts rather than suppresses", () => {
    // A broken reader must never mute a watchdog. Empty -> lastCleanShutdownMs
    // null -> restartExplainsSilence false -> alert proceeds.
    const tail = readLifecycleTail(1024, "C:/definitely/not/a/real/path.log");
    expect(tail).toBe("");
    expect(restartExplainsSilence(lastCleanShutdownMs(tail, SID), Date.now())).toBe(false);
  });
});
