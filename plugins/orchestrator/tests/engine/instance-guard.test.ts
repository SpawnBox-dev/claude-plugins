import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeSession,
  readSessions,
  removeSession,
  removeOwnSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// WI e0f426c2. Claude Code reloads a plugin by starting the NEW MCP for a
// session and THEN stopping the old one, so both are briefly alive under the
// same session_id. The shutdown path used an unguarded
// `DELETE FROM sessions WHERE session_id = ?`, which deleted the row the new
// instance had just registered.
//
// On its own that is a transient wound: registration is once-per-process, but
// the heartbeat's UPSERT rewrites the row within 30s. On 2026-08-09 the
// heartbeat was ALSO broken (fb41a98 - a telemetry probe ran before the
// registry write inside a shared try/catch), so nothing healed it and the
// session stayed INVISIBLE to the fleet for ~2.5 hours: peers dropped it from
// the roster, its output stopped mirroring to PA, while its process logged
// "alive" every 5 minutes and its MCP tools answered normally.
//
// Two defects, each survivable alone, compounding into silent death. These
// tests pin the guard so the reload half cannot come back.

function freshDir() {
  const root = mkdtempSync(join(tmpdir(), "orch-ig-"));
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
        // Windows holds the SQLite file briefly after close.
      }
    },
  };
}

const SID = "reloading-session-uuid";

function entry(instance: string | null): SessionEntry {
  return {
    session_id: SID,
    id8: "reloadin",
    role: "subordinate",
    name: "SA-RELOAD",
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    current_task: null,
    instance,
  };
}

describe("WI e0f426c2: a departing instance must not delete its successor", () => {
  let dirs: ReturnType<typeof freshDir>;
  beforeEach(() => {
    dirs = freshDir();
  });
  afterEach(() => dirs.cleanup());

  const present = () =>
    readSessions(dirs.stateDir).some((s) => s.session_id === SID);

  test("THE RELOAD SEQUENCE: register(new) then shutdown(old) - the row SURVIVES", () => {
    // Exactly the ordering Claude Code uses. Before the guard, the third line
    // deleted what the second line wrote.
    writeSession(dirs.stateDir, entry("instance-OLD"));
    writeSession(dirs.stateDir, entry("instance-NEW")); // reload: new MCP takes over
    removeOwnSession(dirs.stateDir, SID, "instance-OLD"); // old MCP shuts down

    expect(present()).toBe(true);
    expect(readSessions(dirs.stateDir).find((s) => s.session_id === SID)?.instance)
      .toBe("instance-NEW");
  });

  test("an instance CAN still remove its own row on a clean shutdown", () => {
    // The guard must not turn shutdown into a leak - a genuinely departing
    // session should still disappear promptly rather than wait to be reaped.
    writeSession(dirs.stateDir, entry("instance-ONLY"));
    expect(present()).toBe(true);
    removeOwnSession(dirs.stateDir, SID, "instance-ONLY");
    expect(present()).toBe(false);
  });

  test("a row written by a PRE-GUARD MCP is still removable", () => {
    // Mixed-version fleet: a row from an older build carries instance=NULL.
    // Treating NULL as "ours" keeps cleanup working instead of leaking rows
    // that nothing will ever delete.
    writeSession(dirs.stateDir, entry(null));
    removeOwnSession(dirs.stateDir, SID, "instance-WHATEVER");
    expect(present()).toBe(false);
  });

  test("the PEER-REAPER path stays unguarded", () => {
    // removeSession is used to evict a peer we have decided is gone, and we
    // never know which process wrote that row. Guarding it would make the
    // reaper unable to reap.
    writeSession(dirs.stateDir, entry("instance-SOMEONE-ELSE"));
    removeSession(dirs.stateDir, SID);
    expect(present()).toBe(false);
  });

  test("the instance token round-trips through the registry", () => {
    // Guards the plumbing: if writeSession stopped persisting `instance`, every
    // guard above would silently degrade to the old unguarded behaviour while
    // still passing its own assertions.
    writeSession(dirs.stateDir, entry("instance-ROUNDTRIP"));
    const got = readSessions(dirs.stateDir).find((s) => s.session_id === SID);
    expect(got?.instance).toBe("instance-ROUNDTRIP");
  });
});
