process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import {
  writeSession,
  readSessions,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// ===========================================================================
// WI 9082182d - SELF-RETIREMENT COULD NOT FIRE.
//
// `checkSuperseded` is the root-cause fix for 6cf7437a: an orphaned watcher
// left behind by a reload or a `/mcp` reconnect keeps polling, consumes the
// shared offsets row, and eats messages into nothing. Measured cost at the
// time: seven watchers for a four-session fleet, orphans aged 12/15/25 hours,
// delivery falling 100% -> 48% -> 42%.
//
// IT NEVER FIRED ONCE IN PRODUCTION - zero `retired` rows across the whole
// emit-log, zero "instance superseded" lines in the lifecycle log - and not
// because the condition never arose. It arose for hours, in processes that
// provably CONTAINED the code.
//
// THE REASON IS THE ORDER OF TWO STATEMENTS. `heartbeat()` calls
// `writeSession()` and then `checkSuperseded()`, synchronously. The UPSERT in
// `writeSession` carried `started_at = excluded.started_at` unconditionally, so
// the OLD watcher stamped its own older `started_at` onto the shared row and
// then read that value straight back. `theirs === ours`, the `theirs <= ours`
// guard took the early exit, and it stood down never.
//
// The docblock had rejected the `instance` column for flickering under exactly
// this pressure, and then chose a field written by the same unconditional
// UPSERT in the same function. Checkpoint 1cd38a56's warning - "do not ship a
// predicate that reads a coin" - understates it: a coin at least lands heads
// sometimes.
//
// THE FIX IS IN THE STORE, NOT THE CALLER: `started_at` becomes MAX(existing,
// incoming), so an older process physically cannot lower it. That leaves the
// load-bearing 0.55.0 ordering (writeSession must land before any detector
// that can throw) untouched, which moving the check would have broken.
//
// THE FIRST TEST BELOW FAILS ON THE PRE-FIX CODE. That was verified by running
// it red before the fix existed - a retirement assertion that has only ever
// been seen green proves nothing about a mechanism whose entire defect was
// being silently inert.
// ===========================================================================

let baseDir: string;
let projectsHashDir: string;
let stateDir: string;

const SESSION_ID = "abc12345-1234-5678-9abc-def012345678";
const OLD_START = "2026-09-06T20:00:00.000Z";
const NEW_START = "2026-09-06T23:00:00.000Z";

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "self-retire-"));
  projectsHashDir = join(baseDir, "claude-projects", "fixture-project");
  stateDir = join(baseDir, "project", ".orchestrator-state", "agent-channel");
  mkdirSync(projectsHashDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(projectsHashDir, `${SESSION_ID}.jsonl`), "");
});

afterEach(() => {
  closeAgentChannelDb(stateDir);
  rmSync(baseDir, { recursive: true, force: true });
});

function entry(startedAt: string): SessionEntry {
  return {
    session_id: SESSION_ID,
    id8: "abc12345",
    role: "subordinate",
    name: "SA-contested",
    started_at: startedAt,
    last_heartbeat_at: new Date().toISOString(),
  };
}

const retiredRows = () => {
  const p = join(stateDir, "emit-log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.event === "retired");
};

/** A watcher for this session whose own start time is `startedAt`.
 *  `hasClient` mirrors server.ts's `oninitialized` signal (WI f7fef3b7);
 *  omitted means "no client", which is the retire-eligible default. */
function watcher(
  startedAt: string,
  rx: ChannelNotification[] = [],
  hasClient?: boolean,
) {
  return new AgentChannel(
    stateDir,
    projectsHashDir,
    entry(startedAt),
    (n) => rx.push(n),
    undefined,
    undefined,
    hasClient === undefined ? undefined : () => hasClient,
  );
}

const deferredRows = () => {
  const p = join(stateDir, "emit-log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.event === "retire_deferred");
};

describe("WI 9082182d - a superseded watcher stands down", () => {
  test("THE ARM THAT WAS RED: the OLD watcher retires once a newer instance holds the row", () => {
    // The newer instance has claimed the registry row.
    writeSession(stateDir, entry(NEW_START));

    // The older watcher beats twice. Pre-fix, each beat overwrote started_at
    // with OLD_START and then read OLD_START back, so it never retired however
    // many times it ran - which is why beating twice, not once, is the point.
    const old = watcher(OLD_START);
    (old as any).heartbeat();
    (old as any).heartbeat();

    expect((old as any).retired).toBe(true);
    expect(retiredRows().length).toBe(1);
    expect(retiredRows()[0].detail).toContain("superseded");
  });

  test("THE STORE REFUSES TO GO BACKWARDS - the property the fix actually adds", () => {
    // This is the mechanism under the arm above, asserted directly so a future
    // refactor that keeps retirement working by some other route cannot quietly
    // reintroduce a rewindable started_at for everything else that reads it.
    writeSession(stateDir, entry(NEW_START));
    writeSession(stateDir, entry(OLD_START)); // an older process beating

    const row = readSessions(stateDir).find((s) => s.session_id === SESSION_ID);
    expect(row?.started_at).toBe(NEW_START);
  });

  test("NEGATIVE CONTROL: the NEWEST watcher does not retire itself", () => {
    // Without this, a fix that retires everybody would pass the arm above and
    // take the whole fleet down. The dangerous direction is over-retiring, not
    // under-retiring.
    writeSession(stateDir, entry(NEW_START));

    const live = watcher(NEW_START);
    (live as any).heartbeat();
    (live as any).heartbeat();

    expect((live as any).retired).toBeFalsy();
    expect(retiredRows().length).toBe(0);
  });

  test("NEGATIVE CONTROL: a lone watcher with no competitor never retires", () => {
    // The ordinary case, and the one that must never regress: one watcher,
    // its own row, beating normally.
    const solo = watcher(NEW_START);
    (solo as any).heartbeat();
    (solo as any).heartbeat();
    (solo as any).heartbeat();

    expect((solo as any).retired).toBeFalsy();
    expect(retiredRows().length).toBe(0);
  });

  // =========================================================================
  // WI f7fef3b7 - THE REGRESSION THE ARM ABOVE CAUSED IN PRODUCTION.
  //
  // Shipped in 0.69.14/0.69.15, the retirement above fired on PA's window
  // TWICE in one night and deafened its inbound channel both times (364
  // messages sent into a void on the first occurrence; recurrence within 90 s
  // of a reconnect). Claude Code's plugin-manager race spawns a fresh server
  // that NO CLIENT IS ATTACHED TO; it writes a newer started_at, wins the
  // comparison, and the incumbent actually serving the user stands down.
  //
  // Spawn order does not track client attachment, and on that window the two
  // were reliably inverted. The guard uses the one signal a contender cannot
  // forge - a completed MCP handshake - which is the same bar server.ts's
  // dedup path already adopted for the identical failure.
  // =========================================================================
  test("REGRESSION f7fef3b7: a superseded watcher HOLDING A CLIENT does not retire", () => {
    writeSession(stateDir, entry(NEW_START));

    // Older instance, but it is the one a client handshook with - i.e. the
    // incumbent that is actually serving the user.
    const incumbent = watcher(OLD_START, [], true);
    (incumbent as any).heartbeat();
    (incumbent as any).heartbeat();

    expect((incumbent as any).retired).toBeFalsy();
    expect(retiredRows().length).toBe(0);
    // and it must SAY it declined, exactly once, or the decision is invisible
    expect(deferredRows().length).toBe(1);
    expect(deferredRows()[0].detail).toContain("client handshake");
  });

  test("f7fef3b7: a superseded watcher with NO client still retires", () => {
    // The orphan case retirement exists for must keep working - the guard must
    // narrow the behaviour, not disable it.
    writeSession(stateDir, entry(NEW_START));

    const orphan = watcher(OLD_START, [], false);
    (orphan as any).heartbeat();

    expect((orphan as any).retired).toBe(true);
    expect(retiredRows().length).toBe(1);
    expect(deferredRows().length).toBe(0);
  });

  test("f7fef3b7: UNKNOWN client state is treated as no-client (fail to prior behaviour)", () => {
    // No callback supplied - tests and embedders that cannot answer keep the
    // pre-guard behaviour rather than silently never retiring.
    writeSession(stateDir, entry(NEW_START));

    const unknown = watcher(OLD_START); // hasClient undefined
    (unknown as any).heartbeat();

    expect((unknown as any).retired).toBe(true);
  });

  test("f7fef3b7: the decline is logged ONCE, not once per heartbeat", () => {
    // The condition persists until the client moves, so an unconditional line
    // would write every 30 s forever and bury the one that matters.
    writeSession(stateDir, entry(NEW_START));

    const incumbent = watcher(OLD_START, [], true);
    for (let i = 0; i < 5; i++) (incumbent as any).heartbeat();

    expect(deferredRows().length).toBe(1);
    expect((incumbent as any).retired).toBeFalsy();
  });

  test("a retired watcher stops beating, so it stops competing for the row", () => {
    // The docblock's stated ordering property. If a retired instance kept
    // heartbeating it would keep re-stamping the row and could flip ownership
    // back, which is the oscillation this whole item is about.
    writeSession(stateDir, entry(NEW_START));
    const old = watcher(OLD_START);
    (old as any).heartbeat();

    expect((old as any).retired).toBe(true);
    expect((old as any).heartbeatTimer).toBeNull();
    expect((old as any).timer).toBeNull();

    // Beating again must be a no-op, not a second retirement row.
    (old as any).heartbeat();
    expect(retiredRows().length).toBe(1);
  });
});
