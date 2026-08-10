import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeSession,
  readSessions,
  setSessionLiveness,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// WI e3a58e10. The liveness primitive existed in full - three columns, a typed
// union, a setter with freshest-wins + TTL, and a passing test suite - and NO
// PRODUCTION CODE EVER CALLED IT. `liveness_state` was NULL for all 8 live
// sessions. Its own doc comment said "the repurposing query gates on it".
//
// The consumer turned out to be real but human: PA's agent definition tells it
// a repurposing candidate "must be reachable (not egress/ingress-suspect), not
// just idle-looking". With nothing writing the field, PA answered that question
// from whatever suspect-alerts happened to still be in its context - which is
// exactly what a compaction destroys.
//
// The tick loop already COMPUTES these verdicts every pass (classifyIngress /
// classifyClientTransport) and threw them away after emitting an alert. 0.57.0
// persists them. These tests pin the properties that make the persisted value
// trustworthy - the previous suite proved the setter worked in isolation, which
// is what let a never-invoked feature look healthy.

function freshDir() {
  const root = mkdtempSync(join(tmpdir(), "orch-live-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "sessions.json"), JSON.stringify({ sessions: [] }));
  return {
    stateDir,
    cleanup: () => {
      closeAgentChannelDb(stateDir);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows holds the SQLite file briefly after close */
      }
    },
  };
}

const SID = "liveness-subject";

function heartbeat(stateDir: string): void {
  const e: SessionEntry = {
    session_id: SID,
    id8: "livenes1",
    role: "subordinate",
    name: "SA-SUBJECT",
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    current_task: null,
  };
  writeSession(stateDir, e);
}

const stateOf = (d: string) =>
  readSessions(d).find((s) => s.session_id === SID)?.liveness_state ?? null;

describe("WI e3a58e10: liveness must be persisted and must survive", () => {
  let dirs: ReturnType<typeof freshDir>;
  beforeEach(() => {
    dirs = freshDir();
  });
  afterEach(() => dirs.cleanup());

  test("a suspect verdict is READABLE by a peer after being written", () => {
    // The whole point: PA must be able to answer "is this session reachable"
    // by reading state, not by remembering an alert.
    heartbeat(dirs.stateDir);
    expect(stateOf(dirs.stateDir)).toBeNull(); // the bug's starting condition

    setSessionLiveness(dirs.stateDir, SID, {
      state: "ingress_suspect",
      observedAt: new Date().toISOString(),
      ttlSeconds: 600,
    });
    expect(stateOf(dirs.stateDir)).toBe("ingress_suspect");
  });

  test("IT SURVIVES A RESTART - the heartbeat must not erase it", () => {
    // The acceptance gate. liveness_* is deliberately absent from
    // writeSession's ON CONFLICT set, so a restarting session (which carries no
    // liveness in memory) cannot wipe an observation a PEER made about it.
    // This is the same class of bug as current_task (e07f41f5), and the reason
    // that one bit is that it WAS in the clobber set.
    heartbeat(dirs.stateDir);
    setSessionLiveness(dirs.stateDir, SID, {
      state: "client_transport_suspect",
      observedAt: new Date().toISOString(),
      ttlSeconds: 900,
    });
    for (let i = 0; i < 5; i++) heartbeat(dirs.stateDir); // restarted process beats
    expect(stateOf(dirs.stateDir)).toBe("client_transport_suspect");
  });

  test("recovery CLEARS it - a watchdog that cannot stand down is broken", () => {
    heartbeat(dirs.stateDir);
    setSessionLiveness(dirs.stateDir, SID, {
      state: "ingress_suspect",
      observedAt: "2026-08-10T18:00:00.000Z",
      ttlSeconds: 600,
    });
    setSessionLiveness(dirs.stateDir, SID, {
      state: "healthy",
      observedAt: "2026-08-10T18:01:00.000Z",
    });
    expect(stateOf(dirs.stateDir)).toBe("healthy");
  });

  test("a STALER observation cannot overwrite a fresher one", () => {
    // Peers observe independently and their ticks interleave, so ordering is
    // not guaranteed by arrival. Freshest-wins is what makes concurrent
    // observers safe.
    heartbeat(dirs.stateDir);
    setSessionLiveness(dirs.stateDir, SID, {
      state: "healthy",
      observedAt: "2026-08-10T18:05:00.000Z",
    });
    setSessionLiveness(dirs.stateDir, SID, {
      state: "ingress_suspect",
      observedAt: "2026-08-10T18:00:00.000Z", // older observation, arrives late
      ttlSeconds: 600,
    });
    expect(stateOf(dirs.stateDir)).toBe("healthy");
  });

  test("the new client_transport_suspect state round-trips", () => {
    // Guards the type extension: a state the column cannot store would be
    // silently dropped and read back as "no problem".
    heartbeat(dirs.stateDir);
    setSessionLiveness(dirs.stateDir, SID, {
      state: "client_transport_suspect",
      observedAt: new Date().toISOString(),
      ttlSeconds: 900,
    });
    const e = readSessions(dirs.stateDir).find((s) => s.session_id === SID)!;
    expect(e.liveness_state).toBe("client_transport_suspect");
    expect(e.liveness_expires_at).toBeTruthy();
  });
});
