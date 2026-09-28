// Force :memory: DB path BEFORE agent_channel_state loads - see the note in
// agent_channel_routing.test.ts (bun:sqlite holds the file handle on Windows).
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import {
  writeSession,
  readSessions,
  setClientUnreachableSince,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// ===========================================================================
// WI cb376ece - A LANE THAT RAN /clear KEEPS ITS ADDRESS AND ITS POSTS ROUTE.
//
// THE BREAK (2026-09-27). `/clear` starts a new transcript under a new id and
// does NOT restart MCP servers. Every watcher derived a sender's transcript
// from its ADDRESS (`<session_id>.jsonl`), so the new file belonged to no row:
// its lines were consumed as unknown_sender and dropped. Messages TO the lane
// kept arriving (delivery goes to its MCP), so its task line and its replies
// to rulings looked healthy. Two lanes lost every post for ~23 hours, and the
// one alert that fired about them was dismissed on exactly that evidence.
//
// THE FIX. The lane's own server reads the id of the transcript its harness is
// writing now (the per-PID file the SessionStart hook rewrites on /clear) and
// declares it on its row as `transcript_id`. Watchers resolve that file to the
// row. The address never changes, so no peer has to learn a new one.
// ===========================================================================

const PROJECT_HASH = "fixture-project";

let baseDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "continued-session-"));
  projectsHashDir = join(baseDir, "claude-projects", PROJECT_HASH);
  stateDir = join(baseDir, "project", ".orchestrator-state", "agent-channel");
  mkdirSync(projectsHashDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  closeAgentChannelDb(stateDir);
  rmSync(baseDir, { recursive: true, force: true });
});

function makeSession(role: "prime" | "subordinate", id8: string, name: string): SessionEntry {
  return {
    session_id: `${id8}-1234-5678-9abc-def012345678`,
    id8,
    role,
    name,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  };
}

const NEW_TID = "cccccccc-1234-5678-9abc-def012345678";

const file = (sid: string) => join(projectsHashDir, `${sid}.jsonl`);

/** The opening records Claude Code writes into a transcript born of /clear:
 *  it carries the lane's name across (measured on 89c514ba and 28c6b633). */
function writeClearedHeader(tid: string, laneName: string): void {
  writeFileSync(
    file(tid),
    JSON.stringify({ type: "custom-title", customTitle: laneName, sessionId: tid }) + "\n" +
      JSON.stringify({ type: "agent-name", agentName: laneName, sessionId: tid }) + "\n",
  );
}

function appendAssistant(path: string, text: string): void {
  appendFileSync(
    path,
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { content: [{ type: "text", text }] },
    }) + "\n",
  );
}

function laneChannel(sa: SessionEntry, live: () => string | undefined, rx: ChannelNotification[] = []) {
  return new AgentChannel(
    stateDir,
    projectsHashDir,
    sa,
    (n) => rx.push(n),
    undefined,
    undefined,
    undefined,
    live,
  );
}

const routedFrom = (rx: ChannelNotification[], sid: string) =>
  rx.filter((n) => n.meta.from_session === sid && n.meta.event_type === "assistant_text");

describe("cb376ece: a lane that ran /clear keeps routing under its address", () => {
  test("the lane declares the transcript it is writing, and keeps its address", () => {
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, sa);
    const saChan = laneChannel(sa, () => NEW_TID);

    (saChan as any).followLiveTranscript();

    const row = readSessions(stateDir).find((s) => s.session_id === sa.session_id);
    expect(row?.transcript_id).toBe(NEW_TID);
    // The address is the row's key and is untouched.
    expect(readSessions(stateDir).some((s) => s.session_id === NEW_TID)).toBe(false);
  });

  test("POSITIVE: a post written to the NEW transcript reaches PA from the OLD address", () => {
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);
    writeFileSync(file(pa.session_id), "");
    writeFileSync(file(sa.session_id), "");

    const rx: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (paChan as any).tick();

    // The lane runs /clear: the hook rewrites its per-PID file, its server
    // follows before the new transcript exists.
    (laneChannel(sa, () => NEW_TID) as any).followLiveTranscript();

    writeClearedHeader(NEW_TID, sa.name);
    appendAssistant(file(NEW_TID), "@PA first post after the clear");
    (paChan as any).tick(); // first sight of the new file
    (paChan as any).tick(); // backfill pass
    appendAssistant(file(NEW_TID), "@PA second post after the clear");
    (paChan as any).tick();

    const got = routedFrom(rx, sa.session_id).map((n) => n.content);
    expect(got).toEqual(
      expect.arrayContaining([
        expect.stringContaining("first post after the clear"),
        expect.stringContaining("second post after the clear"),
      ]),
    );
  });

  test("NEGATIVE CONTROL: without the declaration, the same posts are dropped (the 09-27 break)", () => {
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);
    writeFileSync(file(pa.session_id), "");
    writeFileSync(file(sa.session_id), "");

    const rx: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (paChan as any).tick();

    writeClearedHeader(NEW_TID, sa.name);
    (paChan as any).tick();
    appendAssistant(file(NEW_TID), "@PA a post nobody routes");
    (paChan as any).tick();

    expect(routedFrom(rx, sa.session_id)).toHaveLength(0);
    expect((paChan as any).unroutedSeen.get(NEW_TID)?.count).toBe(1);
  });

  test("a row whose own id IS the transcript wins over a stale alias (after /mcp)", () => {
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const old = { ...makeSession("subordinate", "bbbbbbbb", "SA-LANE"), transcript_id: NEW_TID };
    const reRegistered: SessionEntry = {
      ...makeSession("subordinate", "cccccccc", "SA-LANE"),
      session_id: NEW_TID,
    };
    writeSession(stateDir, pa);
    writeSession(stateDir, old);
    writeSession(stateDir, reRegistered);
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, () => {});
    (paChan as any).detectSessionChanges();

    const identity: Map<string, SessionEntry> = (paChan as any).identityRoster();
    expect(identity.get(NEW_TID)?.session_id).toBe(NEW_TID);
  });

  test("never follows onto another registered session's address", () => {
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);
    const saChan = laneChannel(sa, () => pa.session_id);

    (saChan as any).followLiveTranscript();

    const row = readSessions(stateDir).find((s) => s.session_id === sa.session_id);
    expect(row?.transcript_id ?? null).toBeNull();
  });

  test("a /resume back to the original transcript clears the declaration", () => {
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, sa);
    let live = NEW_TID;
    const saChan = laneChannel(sa, () => live);
    (saChan as any).followLiveTranscript();
    live = sa.session_id;
    (saChan as any).followLiveTranscript();

    const row = readSessions(stateDir).find((s) => s.session_id === sa.session_id);
    expect(row?.transcript_id ?? null).toBeNull();
  });

  test("canonicalSessionId maps the live transcript id to the address", () => {
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, sa);
    const saChan = laneChannel(sa, () => NEW_TID);
    (saChan as any).followLiveTranscript();

    expect(saChan.canonicalSessionId(NEW_TID)).toBe(sa.session_id);
    expect(saChan.canonicalSessionId(sa.session_id)).toBe(sa.session_id);
    expect(saChan.canonicalSessionId("unrelated-id")).toBe("unrelated-id");
  });
});

describe("cb376ece: the transport self-check measures the live transcript", () => {
  function arm(chan: AgentChannel) {
    (chan as any).emit({
      content: "x",
      meta: {
        from_session: "p",
        from_id8: "p",
        from_role: "prime",
        from_name: "PA",
        from_task: null,
        event_type: "assistant_text",
        ts: new Date().toISOString(),
      },
    });
  }

  test("growth of the NEW transcript counts as delivery", () => {
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, sa);
    writeFileSync(file(sa.session_id), "x".repeat(5000) + "\n");
    const saChan = laneChannel(sa, () => NEW_TID);

    arm(saChan);
    (saChan as any).followLiveTranscript();
    writeClearedHeader(NEW_TID, sa.name); // far smaller than the old file
    (saChan as any).checkOwnTransport();

    expect((saChan as any).pendingEmitAt).toBeNull();
  });

  test("it is the NEW file being measured: an unchanged empty old file does not block the clear", () => {
    // Discriminates "measures the live transcript" from "measures the file
    // named after the address": here only the new file can show growth.
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, sa);
    writeFileSync(file(sa.session_id), "");
    const saChan = laneChannel(sa, () => NEW_TID);

    arm(saChan);
    (saChan as any).followLiveTranscript();
    writeClearedHeader(NEW_TID, sa.name);
    (saChan as any).checkOwnTransport();

    expect((saChan as any).pendingEmitAt).toBeNull();
  });

  test("CONTROL: growth of the OLD transcript no longer counts once the lane moved", () => {
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, sa);
    writeFileSync(file(sa.session_id), "old\n");
    const saChan = laneChannel(sa, () => NEW_TID);

    arm(saChan);
    (saChan as any).followLiveTranscript();
    appendFileSync(file(sa.session_id), "an unrelated write to the abandoned file\n");
    (saChan as any).checkOwnTransport();

    expect(typeof (saChan as any).pendingEmitAt).toBe("number");
  });
});

describe("cb376ece / KB 27f1613d: plumbing alarms are user escalations through PA", () => {
  function fleet() {
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const sa1 = makeSession("subordinate", "bbbbbbbb", "SA-ONE");
    const sa2 = makeSession("subordinate", "dddddddd", "SA-TWO");
    for (const s of [pa, sa1, sa2]) {
      writeSession(stateDir, s);
      writeFileSync(file(s.session_id), "{}\n");
    }
    return { pa, sa1, sa2 };
  }

  const transportAlerts = (rx: ChannelNotification[]) =>
    rx.filter((n) => n.meta.event_type === "client_transport_suspect");

  test("PA surfaces a subordinate's transport alert, flagged for the user, with evidence", () => {
    const { pa, sa2 } = fleet();
    setClientUnreachableSince(stateDir, sa2.session_id, new Date(Date.now() - 20 * 60_000).toISOString());
    const rx: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (paChan as any).detectSessionChanges();
    (paChan as any).detectIngress((paChan as any).currentRoster, Date.now());

    const alerts = transportAlerts(rx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].meta.escalate_to_user).toBe(true);
    expect(alerts[0].content).toContain("USER ESCALATION");
    expect(alerts[0].content).toContain(`${sa2.session_id}.jsonl`);
    expect(alerts[0].content).toContain("last written");
  });

  test("a subordinate does NOT surface a peer subordinate's alert (it was costing every lane a turn)", () => {
    const { sa1, sa2 } = fleet();
    setClientUnreachableSince(stateDir, sa2.session_id, new Date(Date.now() - 20 * 60_000).toISOString());
    const rx: ChannelNotification[] = [];
    const saChan = new AgentChannel(stateDir, projectsHashDir, sa1, (n) => rx.push(n));
    (saChan as any).detectSessionChanges();
    (saChan as any).detectIngress((saChan as any).currentRoster, Date.now());

    expect(transportAlerts(rx)).toHaveLength(0);
  });

  test("a subordinate DOES surface it when PA is the subject - PA's harness is the broken path", () => {
    const { pa, sa1 } = fleet();
    setClientUnreachableSince(stateDir, pa.session_id, new Date(Date.now() - 20 * 60_000).toISOString());
    const rx: ChannelNotification[] = [];
    const saChan = new AgentChannel(stateDir, projectsHashDir, sa1, (n) => rx.push(n));
    (saChan as any).detectSessionChanges();
    (saChan as any).detectIngress((saChan as any).currentRoster, Date.now());

    expect(transportAlerts(rx)).toHaveLength(1);
  });

  test("the evidence is measured on the transcript the subject DECLARES, not the one named after it", () => {
    const { pa, sa2 } = fleet();
    writeSession(stateDir, { ...sa2, transcript_id: NEW_TID });
    writeClearedHeader(NEW_TID, sa2.name);
    setClientUnreachableSince(stateDir, sa2.session_id, new Date(Date.now() - 20 * 60_000).toISOString());
    const rx: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (paChan as any).detectSessionChanges();
    (paChan as any).detectIngress((paChan as any).currentRoster, Date.now());

    expect(transportAlerts(rx)[0].content).toContain(`${NEW_TID}.jsonl`);
  });
});

describe("cb376ece: a lane whose posts are dropped is named to the user", () => {
  function setupDropped() {
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);
    writeFileSync(file(pa.session_id), "");
    writeFileSync(file(sa.session_id), "");
    const rx: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (paChan as any).tick();
    return { pa, sa, rx, paChan };
  }

  const unrouted = (rx: ChannelNotification[]) =>
    rx.filter((n) => n.meta.event_type === "unrouted_transcript");

  test("POSITIVE: an unowned transcript naming a live lane escalates, once", () => {
    const { sa, rx, paChan } = setupDropped();
    writeClearedHeader(NEW_TID, sa.name);
    (paChan as any).tick();
    appendAssistant(file(NEW_TID), "@PA this post is being dropped");
    (paChan as any).tick();

    (paChan as any).detectUnroutedTranscripts((paChan as any).currentRoster, Date.now());
    (paChan as any).detectUnroutedTranscripts((paChan as any).currentRoster, Date.now());

    const alerts = unrouted(rx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].meta.escalate_to_user).toBe(true);
    expect(alerts[0].meta.from_session).toBe(sa.session_id);
    expect(alerts[0].content).toContain(`${NEW_TID}.jsonl`);
    expect(alerts[0].content).toContain(sa.name);
  });

  test("CONTROL: an unowned transcript that names NO roster row stays quiet (a plain claude run)", () => {
    const { rx, paChan } = setupDropped();
    writeClearedHeader(NEW_TID, "some-unrelated-session");
    (paChan as any).tick();
    appendAssistant(file(NEW_TID), "just a plain claude session in this folder");
    (paChan as any).tick();

    (paChan as any).detectUnroutedTranscripts((paChan as any).currentRoster, Date.now());
    expect(unrouted(rx)).toHaveLength(0);
  });

  test("once the lane declares the file, it is owned and the escalation stops", () => {
    const { sa, rx, paChan } = setupDropped();
    writeClearedHeader(NEW_TID, sa.name);
    (paChan as any).tick();
    appendAssistant(file(NEW_TID), "@PA dropped before the fix landed");
    (paChan as any).tick();
    writeSession(stateDir, { ...sa, transcript_id: NEW_TID });
    (paChan as any).detectSessionChanges();

    (paChan as any).detectUnroutedTranscripts((paChan as any).currentRoster, Date.now());
    expect(unrouted(rx)).toHaveLength(0);
  });
});
