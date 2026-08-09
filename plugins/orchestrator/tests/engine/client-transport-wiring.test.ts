import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentChannel } from "../../mcp/engine/agent_channel";
import {
  closeAgentChannelDb,
  writeSession,
  readSessions,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";
import { appendSystemEvent } from "../../mcp/engine/agent_channel_state";

// WI d4873dfc, WIRING half. client-transport.test.ts proves the DECISION; this
// proves the decision is actually reached and published.
//
// Worth its own file because the classifier is pure and therefore passes
// whether or not anything calls it. A guard nothing invokes is the failure this
// lane keeps finding, and it looks identical to a working one from the test
// output alone.

function freshTempDir() {
  const root = mkdtempSync(join(tmpdir(), "orch-ct-"));
  const stateDir = join(root, "state");
  const projectsDir = join(root, "projects");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(stateDir, "sessions.json"), JSON.stringify({ sessions: [] }));
  return {
    stateDir,
    projectsDir,
    cleanup: () => {
      closeAgentChannelDb(stateDir);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows holds the SQLite file briefly after close; a leftover temp
        // dir must not fail an otherwise-passing test.
      }
    },
  };
}

const SELF_ID = "pa-session-uuid";

function makeSelf(): SessionEntry {
  return {
    session_id: SELF_ID,
    id8: "pa-sessi",
    role: "prime",
    name: "PA",
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    current_task: null,
  };
}

describe("WI d4873dfc wiring: emit arms, growth clears, silence publishes", () => {
  let dirs: ReturnType<typeof freshTempDir>;
  let channel: AgentChannel;
  let transcript: string;

  beforeEach(() => {
    dirs = freshTempDir();
    const self = makeSelf();
    writeSession(dirs.stateDir, self);
    transcript = join(dirs.projectsDir, `${SELF_ID}.jsonl`);
    writeFileSync(transcript, "");
    channel = new AgentChannel(dirs.stateDir, dirs.projectsDir, self, () => {});
  });
  afterEach(() => dirs.cleanup());

  /** Drive a real emit through the production path, not a hand-set field. */
  function causeEmit(requestId: string): void {
    appendSystemEvent(dirs.stateDir, {
      event_type: "permission_request_pending",
      from_session: "sa-session-uuid",
      to_session: SELF_ID,
      ts: new Date().toISOString(),
      request_id: requestId,
      tool_name: "Bash",
      description: "Run a command",
      input_preview: "ls -la",
    });
    (channel as any).processSystemEvents();
  }

  function publishedSince(): string | null | undefined {
    return readSessions(dirs.stateDir).find((s) => s.session_id === SELF_ID)
      ?.client_unreachable_since;
  }

  test("an emit ARMS the expectation", () => {
    expect((channel as any).pendingEmitAt).toBeNull();
    causeEmit("req-1");
    expect(typeof (channel as any).pendingEmitAt).toBe("number");
  });

  test("transcript growth CLEARS it, and nothing is published", () => {
    causeEmit("req-1");
    // The harness wrote the injection down - i.e. the transport carried it.
    appendFileSync(transcript, JSON.stringify({ type: "queue-operation" }) + "\n");
    (channel as any).checkOwnTransport();
    expect((channel as any).pendingEmitAt).toBeNull();
    expect(publishedSince() ?? null).toBeNull();
  });

  test("NO growth past the threshold PUBLISHES the verdict", () => {
    causeEmit("req-1");
    // Age the outstanding emit past the grace window without touching the
    // transcript - the measured shape of PA's freeze.
    (channel as any).pendingEmitAt = Date.now() - (16 * 60_000);
    (channel as any).checkOwnTransport();
    const since = publishedSince();
    expect(typeof since).toBe("string");
    expect(Number.isNaN(Date.parse(since as string))).toBe(false);
  });

  test("recovery STANDS THE ALERT DOWN", () => {
    // A watchdog that cannot stand down is as broken as one that cannot fire.
    causeEmit("req-1");
    (channel as any).pendingEmitAt = Date.now() - (16 * 60_000);
    (channel as any).checkOwnTransport();
    expect(typeof publishedSince()).toBe("string");

    appendFileSync(transcript, JSON.stringify({ type: "queue-operation" }) + "\n");
    (channel as any).checkOwnTransport();
    expect(publishedSince() ?? null).toBeNull();
  });

  test("THE RESET BUG: a later emit must not restart the clock", () => {
    // The trap this design nearly shipped. Stamping every emit would mean a
    // session emitting steadily THROUGH an outage keeps refreshing its own
    // deadline and never crosses it - silent exactly when traffic is heaviest,
    // which is precisely the 11-hour case. Oldest-unsatisfied, like the ingress
    // check's oldest ORPHAN enqueue.
    causeEmit("req-1");
    const armed = (channel as any).pendingEmitAt as number;
    const aged = Date.now() - (16 * 60_000);
    (channel as any).pendingEmitAt = aged;

    causeEmit("req-2"); // more traffic, still undelivered
    expect((channel as any).pendingEmitAt).toBe(aged);
    expect((channel as any).pendingEmitAt).toBeLessThan(armed);

    (channel as any).checkOwnTransport();
    expect(typeof publishedSince()).toBe("string");
  });
});
