// Force :memory: DB path BEFORE agent_channel_state loads - see the note in
// agent_channel_routing.test.ts (bun:sqlite holds the file handle on Windows).
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  AgentChannel,
  decorateChannelContent,
  type ChannelNotification,
} from "../../mcp/engine/agent_channel";
import { parseAddressing } from "../../mcp/engine/addressing";
import {
  writeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// ===========================================================================
// WI 2292ba6c - THE HEADER NAMES EVERY AUDIENCE A POST ADDRESSED, NOT JUST PA.
//
// Specimen, 2026-09-28 18:29:11Z: W2-B's handoff opened
// `@@@ @SA-89c514ba,@PA,@all`. Routing was right - all seven sessions got it -
// but every receiver, including DESK (the lane being handed the live checks),
// was shown `[SA-2f7c0e1a] @PA-36abe436 | ...`, which reads as "PA's mail, you
// are observing". The header exists to say the opposite.
// ===========================================================================

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

const PA = makeSession("prime", "aaaaaaaa", "PA-test");
const DESK = makeSession("subordinate", "bbbbbbbb", "SA-DESK");
const W2B = makeSession("subordinate", "cccccccc", "SA-W2B");
const OTHER = makeSession("subordinate", "dddddddd", "SA-OTHER");
const SESSIONS = [PA, DESK, W2B, OTHER];

/** The header a receiver sees, the way the router builds it for an SA. */
function headerAt(receiver: SessionEntry, text: string): string {
  const addr = parseAddressing(text, W2B, SESSIONS);
  const targets = receiver.role === "prime" ? addr.targets : [receiver.session_id];
  const out = decorateChannelContent("body", W2B, "assistant_text", targets, addr.pa_addressed, SESSIONS, addr.all_addressed);
  return out.slice(0, out.indexOf(" | "));
}

describe("2292ba6c: header labels", () => {
  test("SPECIMEN: @SA-desk,@PA,@all is not shown to DESK as PA-only", () => {
    const h = headerAt(DESK, "@@@ @SA-bbbbbbbb,@PA,@all\nstart the live checks\n@@@");
    expect(h).not.toBe("[SA-cccccccc] @PA-aaaaaaaa");
    expect(h).toBe("[SA-cccccccc] @all");
  });

  test("@SA-desk,@PA names both, to DESK and to PA", () => {
    const text = "@SA-bbbbbbbb,@PA start the live checks";
    expect(headerAt(DESK, text)).toBe("[SA-cccccccc] @PA-aaaaaaaa,@SA-bbbbbbbb");
    expect(headerAt(PA, text)).toBe("[SA-cccccccc] @PA-aaaaaaaa,@SA-bbbbbbbb");
  });

  test("CONTROL: a PA-only post still reads PA-only", () => {
    expect(headerAt(PA, "@PA the build is done")).toBe("[SA-cccccccc] @PA-aaaaaaaa");
  });

  test("CONTROL: an SA-only post still names just that SA", () => {
    expect(headerAt(DESK, "@SA-bbbbbbbb start the live checks")).toBe("[SA-cccccccc] @SA-bbbbbbbb");
  });

  test("CONTROL: unaddressed prose gets no header at all", () => {
    const addr = parseAddressing("just thinking out loud", W2B, SESSIONS);
    expect(addr.all_addressed).toBe(false);
    expect(decorateChannelContent("x", W2B, "assistant_text", addr.targets, addr.pa_addressed, SESSIONS, addr.all_addressed)).toBe("x");
  });
});

// ── The router, end to end: what DESK's watcher actually emits ──────────────

let baseDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "header-audience-"));
  projectsHashDir = join(baseDir, "claude-projects", "fixture-project");
  stateDir = join(baseDir, "project", ".orchestrator-state", "agent-channel");
  mkdirSync(projectsHashDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  closeAgentChannelDb(stateDir);
  rmSync(baseDir, { recursive: true, force: true });
});

describe("2292ba6c: the router's emit to an addressed SA", () => {
  test("SPECIMEN end to end: DESK's watcher labels W2-B's @SA-desk,@PA,@all handoff @all", () => {
    for (const s of SESSIONS) writeSession(stateDir, s);
    const file = (s: SessionEntry) => join(projectsHashDir, `${s.session_id}.jsonl`);
    for (const s of SESSIONS) writeFileSync(file(s), "");
    const rx: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, DESK, (n) => rx.push(n));
    (chan as any).tick();
    (chan as any).tick();

    const text = "Handoff.\n\n@@@ @SA-bbbbbbbb,@PA,@all\n**DESK:** A, then B, then C are yours now.\n@@@";
    appendFileSync(
      file(W2B),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n",
    );
    (chan as any).tick();

    const got = rx.filter(
      (n) => n.meta.from_session === W2B.session_id && n.meta.event_type === "assistant_text",
    );
    expect(got).toHaveLength(1);
    expect(got[0].content.startsWith("[SA-cccccccc] @all | ")).toBe(true);
  });
});
