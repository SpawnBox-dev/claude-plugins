import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeSession,
  readSessions,
  setCurrentTask,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// WI e07f41f5. `sessions.current_task` in the agent-channel registry was empty
// for all 8 live sessions, and two things read it:
//
//   1. the POST-COMPACT PEER ROSTER - getLiveSessions() reads this table, and
//      hook_event.ts renders `current_task ?? "(no task set)"` for every peer.
//      So PA rebuilt a blank fleet picture after every compaction while
//      session_registry (a DIFFERENT database) held a current task for each.
//   2. `from_task` on every channel notification (six emit sites).
//
// Two independent causes, both fixed here and both pinned below:
//   A. nothing ever WROTE it - server.ts builds selfSession with
//      current_task: null and never assigns it, and update_session_task only
//      wrote session_registry.
//   B. even if something had, the 30s heartbeat's UPSERT overwrote it with
//      that same null every beat.
//
// A fix for only one of those looks like it works: (A) alone gets erased
// within 30 seconds, (B) alone leaves the column empty forever.

function freshDir() {
  const root = mkdtempSync(join(tmpdir(), "orch-task-"));
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

const SID = "task-mirror-session";

/** A heartbeat: base fields only, and NO task - exactly what the real one
 *  carries, since selfSession.current_task is null on a fresh process. */
function heartbeat(stateDir: string): void {
  const entry: SessionEntry = {
    session_id: SID,
    id8: "task-mir",
    role: "subordinate",
    name: "SA-TASK",
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    current_task: null,
  };
  writeSession(stateDir, entry);
}

const taskOf = (stateDir: string) =>
  readSessions(stateDir).find((s) => s.session_id === SID)?.current_task ?? null;

describe("WI e07f41f5: the broadcast task must reach the agent-channel roster", () => {
  let dirs: ReturnType<typeof freshDir>;
  beforeEach(() => {
    dirs = freshDir();
  });
  afterEach(() => dirs.cleanup());

  test("a set task SURVIVES a heartbeat that carries none", () => {
    // Cause B. Before the COALESCE this failed within one beat: the heartbeat
    // wrote its own null straight over the value.
    heartbeat(dirs.stateDir); // registers the row
    setCurrentTask(dirs.stateDir, SID, "LANDING lane: 5 feedback WIs");
    expect(taskOf(dirs.stateDir)).toBe("LANDING lane: 5 feedback WIs");

    heartbeat(dirs.stateDir);
    heartbeat(dirs.stateDir);
    expect(taskOf(dirs.stateDir)).toBe("LANDING lane: 5 feedback WIs");
  });

  test("it survives an MCP RESTART, which is when the in-memory copy is lost", () => {
    // The restart case specifically: a fresh process has no task in memory, so
    // every beat it sends is a null. The registry copy is the only survivor,
    // and it is what the post-compact roster reads.
    heartbeat(dirs.stateDir);
    setCurrentTask(dirs.stateDir, SID, "FIXER lane - reserve, idle-available");
    for (let i = 0; i < 5; i++) heartbeat(dirs.stateDir); // "new process" beats
    expect(taskOf(dirs.stateDir)).toBe("FIXER lane - reserve, idle-available");
  });

  test("a session that DOES hold a task can still update it", () => {
    // The COALESCE must not freeze the value: a real heartbeat carrying a task
    // has to win, or a session could never change what it broadcasts.
    heartbeat(dirs.stateDir);
    setCurrentTask(dirs.stateDir, SID, "old task");
    writeSession(dirs.stateDir, {
      session_id: SID,
      id8: "task-mir",
      role: "subordinate",
      name: "SA-TASK",
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      current_task: "new task",
    });
    expect(taskOf(dirs.stateDir)).toBe("new task");
  });

  test("the roster renders a real task, not the blank PA was seeing", () => {
    // End-to-end shape of the bug: readSessions is what getLiveSessions
    // returns, and hook_event renders `current_task ?? "(no task set)"`.
    heartbeat(dirs.stateDir);
    setCurrentTask(dirs.stateDir, SID, "ORCH-IMP: shipped 0.56.0");
    heartbeat(dirs.stateDir);

    const peer = readSessions(dirs.stateDir).find((s) => s.session_id === SID)!;
    const rendered = peer.current_task?.trim()
      ? `: ${peer.current_task}`
      : ": (no task set)";
    expect(rendered).toBe(": ORCH-IMP: shipped 0.56.0");
    expect(rendered).not.toBe(": (no task set)");
  });
});
