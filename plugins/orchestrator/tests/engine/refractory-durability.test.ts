import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAlertLastEmit,
  setAlertLastEmit,
  lastSystemEventFrom,
  appendSystemEvent,
  closeAgentChannelDb,
} from "../../mcp/engine/agent_channel_state";
import {
  compactGraceActive,
  COMPACT_GRACE_MS,
  ingressRefractoryElapsed,
  INGRESS_SOLE_RECIPIENT_NOTE,
} from "../../mcp/engine/agent_channel";

// ===========================================================================
// 0.32.1: THE SUPPRESSOR'S STORAGE, WHICH IS WHERE IT WAS ACTUALLY BROKEN.
//
// 0.31.7 shipped a 30-minute refractory floor for ingress_suspect and pinned
// it with six tests. All six passed. The floor still failed in production -
// three firings on one subject inside fifty minutes on 2026-07-28.
//
// The tests were not wrong, they were aimed at the wrong half. They exercised
// `ingressRefractoryElapsed`, a pure function of (lastEmit, now), which was
// correct then and is correct now. The defect was that `lastEmit` came from a
// `Map` on the AgentChannel instance:
//
//   - Every session's MCP process runs the channel tick and can emit about any
//     peer. There is no leader election. So each of N processes held its own
//     Map and got its own full allowance - six live sessions turned a 30-minute
//     floor into roughly five.
//   - A plugin reload constructs a new process with an empty Map, resetting the
//     floor to zero part-way through an episode.
//
// Neither is observable from inside a single process, which is exactly why
// review and unit tests both cleared it. The lesson generalises past this
// alert: WHEN A GUARD'S CORRECTNESS DEPENDS ON SHARED STATE, TESTING THE
// PREDICATE PROVES NOTHING - the test has to cross the process boundary the
// real system crosses. These tests use a second "process" (a fresh read
// against the same stateDir) to do that.
// ===========================================================================


// bun:sqlite + WAL + Windows holds WAL/SHM handles briefly after close(), so a
// bare rmSync in teardown hits EBUSY. This is the established convention in
// tests/engine/agent_channel_state.test.ts - copied rather than re-invented.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function teardown(stateDir: string): void {
  closeAgentChannelDb(stateDir);
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(stateDir, { recursive: true, force: true });
      return;
    } catch {
      sleepSync(100);
    }
  }
}

describe("0.32.1: refractory floor survives what it has to survive", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "orch-refractory-"));
  });
  afterEach(() => teardown(stateDir));

  const SUBJECT = "d4c8dda8-80e2-4427-8588-8f4f979a2120";

  test("an emit recorded by ONE process is visible to ANOTHER", () => {
    // The cross-process defect, stated as a test. Process A emits; process B
    // must see the timestamp and stay silent. Under the old in-memory Map, B's
    // lookup returned undefined and B fired immediately.
    const t0 = 1_000_000_000_000;
    setAlertLastEmit(stateDir, "ingress_suspect", SUBJECT, t0);

    // "Process B": same shared DB, no in-memory state carried over.
    const seenByB = getAlertLastEmit(stateDir, "ingress_suspect", SUBJECT);
    expect(seenByB).toBe(t0);
    expect(ingressRefractoryElapsed(seenByB, t0 + 5 * 60_000)).toBe(false);
  });

  test("the record survives a process restart (the /reload-plugins case)", () => {
    // THIS TEST MUST BE FILE-BACKED OR IT PROVES NOTHING, and getting that
    // wrong is not hypothetical - it happened while writing it.
    //
    // tests/engine/agent_channel_state.test.ts sets
    // ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY=":memory:" at MODULE LOAD,
    // and bun runs every test file in one process, so that env var leaks into
    // every file that loads after it. Alone, this test passed against a real
    // file. In the full suite the same code ran against an in-memory DB, where
    // close() legitimately discards everything - so it failed, and had the
    // assertion been inverted it would have PASSED while testing nothing.
    //
    // So: force file-backed for the duration, and ASSERT THE PRECONDITION.
    // A durability test that cannot tell which storage it exercised is not a
    // durability test.
    const saved = process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY;
    delete process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY;
    try {
      const t0 = 1_000_000_000_000;
      setAlertLastEmit(stateDir, "ingress_suspect", SUBJECT, t0);
      // Precondition: there is a real file on disk to survive the restart.
      expect(existsSync(join(stateDir, "agent_channel.db"))).toBe(true);
      // Drop every handle, as a plugin reload does, then re-open cold.
      closeAgentChannelDb(stateDir);
      expect(getAlertLastEmit(stateDir, "ingress_suspect", SUBJECT)).toBe(t0);
    } finally {
      if (saved === undefined) {
        delete process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY;
      } else {
        process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = saved;
      }
    }
  });

  test("still ALLOWS a genuinely new episode once the window elapses", () => {
    // A suppressor that cannot stop suppressing is the failure mirror of one
    // that cannot suppress. Durability must not become permanence.
    const t0 = 1_000_000_000_000;
    setAlertLastEmit(stateDir, "ingress_suspect", SUBJECT, t0);
    const seen = getAlertLastEmit(stateDir, "ingress_suspect", SUBJECT);
    expect(ingressRefractoryElapsed(seen, t0 + 31 * 60_000)).toBe(true);
  });

  test("floors are per (alert_kind, subject) - one alert cannot mute another", () => {
    const t0 = 1_000_000_000_000;
    setAlertLastEmit(stateDir, "ingress_suspect", SUBJECT, t0);
    expect(getAlertLastEmit(stateDir, "egress_suspect", SUBJECT)).toBeUndefined();
    expect(getAlertLastEmit(stateDir, "ingress_suspect", "other-session")).toBeUndefined();
  });

  test("a later emit overwrites the earlier one rather than accumulating", () => {
    setAlertLastEmit(stateDir, "ingress_suspect", SUBJECT, 1_000);
    setAlertLastEmit(stateDir, "ingress_suspect", SUBJECT, 2_000);
    expect(getAlertLastEmit(stateDir, "ingress_suspect", SUBJECT)).toBe(2_000);
  });
});

// ===========================================================================
// Compaction grace: the explanation was already on the bus.
// ===========================================================================
describe("0.32.1: compaction grace reads the published reason", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "orch-compact-"));
  });
  afterEach(() => teardown(stateDir));

  const SUBJECT = "d4c8dda8-80e2-4427-8588-8f4f979a2120";

  test("finds the subject's own compaction event on the shared bus", () => {
    const ts = new Date(1_000_000_000_000).toISOString();
    appendSystemEvent(stateDir, {
      event_type: "pa_compact_recovery",
      from_session: SUBJECT,
      to_session: "some-sa",
      ts,
      payload: "{}",
    });
    const found = lastSystemEventFrom(
      stateDir,
      ["pa_compact_recovery", "post_compact_recovery"],
      SUBJECT
    );
    expect(found).toBe(1_000_000_000_000);
  });

  test("SUPPRESSES the 16-minute gap that actually fired", () => {
    // Real numbers from 2026-07-28: pa_compact_recovery at 13:45:51Z,
    // ingress_suspect at 14:01:46Z on the same session.
    const compact = Date.parse("2026-07-28T13:45:51Z");
    const alert = Date.parse("2026-07-28T14:01:46Z");
    expect(compactGraceActive(compact, alert)).toBe(true);
  });

  test("does NOT suppress once the grace window has passed", () => {
    const compact = 1_000_000_000_000;
    expect(compactGraceActive(compact, compact + COMPACT_GRACE_MS)).toBe(false);
    expect(compactGraceActive(compact, compact + COMPACT_GRACE_MS + 1)).toBe(false);
  });

  test("a subject that never compacted is NOT suppressed", () => {
    // The detector has to stay armed for the case it exists for.
    expect(compactGraceActive(undefined, 1_000_000_000_000)).toBe(false);
    expect(
      lastSystemEventFrom(stateDir, ["pa_compact_recovery"], SUBJECT)
    ).toBeUndefined();
  });

  test("another session's compaction does not mute THIS subject", () => {
    appendSystemEvent(stateDir, {
      event_type: "pa_compact_recovery",
      from_session: "someone-else",
      to_session: SUBJECT,
      ts: new Date(1_000_000_000_000).toISOString(),
    payload: "{}",
    });
    // Keyed on who COMPACTED (from_session), not who was told about it - the
    // recovery advisory is addressed TO peers, so keying on to_session would
    // mute every peer of a compacting session instead of the session itself.
    expect(
      lastSystemEventFrom(stateDir, ["pa_compact_recovery"], SUBJECT)
    ).toBeUndefined();
  });
});

// ===========================================================================
// 0.32.2: making the floor fleet-wide reassigns responsibility. Say so.
// ===========================================================================
describe("0.32.2: the alert states that its reader is the only recipient", () => {
  test("names the sole-recipient fact AND asks for an explicit hand-off", () => {
    // A shared floor means the first emit silences every other process, so
    // exactly one session hears about it. If that session assumes the fleet
    // was told, the suppressor has traded noise for silence - which is the
    // worse of the two failures, because nothing reports it.
    const t = INGRESS_SOLE_RECIPIENT_NOTE.toLowerCase();
    expect(t).toContain("only session");
    // Must not merely inform - it has to close the loop either way, otherwise
    // a reader who declines to triage leaves no trace that nobody did.
    expect(t).toMatch(/say|declare|out loud/);
  });
});
