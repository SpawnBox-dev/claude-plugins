import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAlertLastEmit,
  setAlertLastEmit,
  appendSystemEvent,
  closeAgentChannelDb,
  alertEmissionStats,
} from "../../mcp/engine/agent_channel_state";
import {
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
// 0.34.0: THE COMPACTION GRACE IS REJECTED. Guarding it so it is not re-derived.
//
// 0.32.1 suppressed ingress_suspect for 30 minutes after a session's own
// compaction event. The reasoning was sound: a context rebuild is long and
// silent, the textbook false positive, and the event is already on the bus so
// it cost no instrumentation. SA-c5b207e0 proposed it, I shipped it, and
// SA-b14fafa3 proposed the same thing independently within the hour.
//
// It was removed the same day. Instance 8 turned out to be the detector's
// FIRST TRUE POSITIVE - a real 58-minute MCP transport outage - and it fired
// 15m55s after a compaction, squarely inside the grace. The suppressor would
// have swallowed the only real detection this alert has ever made.
//
// The coincidence is not bad luck, it is structural: compaction is exactly
// when a session is re-establishing transport, so "recently compacted" and
// "transport just died" correlate. That is the general rule now in CLAUDE.md:
// A SUPPRESSOR WHOSE TRIGGER CORRELATES WITH THE FAILURE MODE IS NOT A
// FALSE-POSITIVE FILTER, IT IS A BLINDFOLD.
//
// Three suppressors were proposed this week keying on signals the failure
// itself produces - fleet-quiet, compaction-grace, and transcript-mtime. The
// third was caught at design time in 0.30.77 and is why classifyIngress
// accepts transcriptMtimeMs and deliberately ignores it (see the `void` there
// and tests/engine/ingress-liveness.test.ts). Two careful agents re-invented
// the same blindfold in one day; assume the next one will too.
// ===========================================================================
describe("0.34.0: compaction must NOT suppress ingress_suspect", () => {
  test("the timing of the real incident is inside any plausible grace window", () => {
    // Recorded as data rather than prose so the argument survives rewording.
    const compaction = Date.parse("2026-07-28T13:45:51Z");
    const trueFiring = Date.parse("2026-07-28T14:01:46Z");
    const outageStart = Date.parse("2026-07-28T13:54:00Z");
    const outageEnd = Date.parse("2026-07-28T14:52:00Z");

    // The firing was real: it landed inside a confirmed transport outage.
    expect(trueFiring).toBeGreaterThan(outageStart);
    expect(trueFiring).toBeLessThan(outageEnd);

    // And it sat well inside the 30-minute grace that was briefly shipped.
    const gapMin = (trueFiring - compaction) / 60_000;
    expect(gapMin).toBeLessThan(30);
    expect(Math.round(gapMin)).toBe(16);
  });

  test("no compaction-grace symbol is exported from the channel engine", async () => {
    // A structural guard, not a semantic one: if someone re-adds the export,
    // this fails and they are sent to the comment above before they wire it in.
    const mod = await import("../../mcp/engine/agent_channel");
    expect("compactGraceActive" in mod).toBe(false);
    expect("COMPACT_GRACE_MS" in mod).toBe(false);
  });
});

// ===========================================================================
// 0.32.3: make the detector's own track record queryable.
//
// ingress_suspect is on record as 0-for-8. That record was assembled by agents
// REMEMBERING, across days and three sessions, and re-derived by hand every
// time anyone asked. egress_suspect has no known record at all. These alerts
// are MCP notifications and were never written anywhere, so every tuning
// argument restarted from anecdote - which is most of why this detector took
// eight firings to diagnose.
// ===========================================================================
describe("0.32.3: alert emission stats", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "orch-stats-"));
  });
  afterEach(() => teardown(stateDir));

  const S = "d4c8dda8-80e2-4427-8588-8f4f979a2120";

  test("counts repeat firings against the same subject", () => {
    setAlertLastEmit(stateDir, "ingress_suspect", S, 1_000);
    setAlertLastEmit(stateDir, "ingress_suspect", S, 2_000);
    setAlertLastEmit(stateDir, "ingress_suspect", S, 3_000);
    const [row] = alertEmissionStats(stateDir, "ingress_suspect");
    expect(row.emit_count).toBe(3);
    expect(row.last_emit_ms).toBe(3_000);
  });

  test("first_emit is the FIRST, not the latest - that is what makes it a rate", () => {
    setAlertLastEmit(stateDir, "ingress_suspect", S, 1_000);
    setAlertLastEmit(stateDir, "ingress_suspect", S, 9_000);
    const [row] = alertEmissionStats(stateDir, "ingress_suspect");
    expect(row.first_emit_ms).toBe(1_000);
    expect(row.last_emit_ms).toBe(9_000);
  });

  test("separates kinds and subjects rather than pooling them", () => {
    setAlertLastEmit(stateDir, "ingress_suspect", S, 1_000);
    setAlertLastEmit(stateDir, "egress_suspect", S, 1_000);
    setAlertLastEmit(stateDir, "ingress_suspect", "other", 1_000);
    expect(alertEmissionStats(stateDir).length).toBe(3);
    expect(alertEmissionStats(stateDir, "egress_suspect").length).toBe(1);
  });

  test("counting must not weaken the floor it rides on", () => {
    // The count is a passenger. If bumping it ever reset last_emit_ms the
    // suppressor would silently regress, so pin them together.
    setAlertLastEmit(stateDir, "ingress_suspect", S, 5_000);
    setAlertLastEmit(stateDir, "ingress_suspect", S, 6_000);
    expect(getAlertLastEmit(stateDir, "ingress_suspect", S)).toBe(6_000);
  });

  test("empty on a fresh fleet - no rows, no crash, no phantom zero row", () => {
    expect(alertEmissionStats(stateDir)).toEqual([]);
  });
});
