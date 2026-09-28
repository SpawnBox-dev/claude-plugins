// Force :memory: DB path BEFORE agent_channel_state loads - see the note in
// agent_channel_routing.test.ts (bun:sqlite holds the file handle on Windows).
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import {
  writeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// ===========================================================================
// AN ENVELOPE'S BODY IS LITERAL FOR EVERY PURPOSE, NOT ONLY FOR DELIVERY.
//
// Specimen, 2026-09-28 18:39:51Z: ORCH-FIX posted one `@@@ @PA` envelope whose
// body quoted another post's opener in backticks: "`@SA-89c514ba,@PA,@all`".
// Delivery was right - only PA got it - but the post-level addressing was
// parsed over the WHOLE text, envelope body included:
//   - PA's notification carried addressed_to = all 7 sessions;
//   - all 6 SA watchers logged `paragraph_filtered` ("addressed to us but no
//     paragraph survived"), a false delivery-loss alarm in the instrument
//     built to catch real ones (WI 6cf7437a);
//   - and with 2292ba6c the header would have read `@all` to PA.
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
const ORCH = makeSession("subordinate", "cccccccc", "SA-ORCH");
const SESSIONS = [PA, DESK, ORCH];

let baseDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "envelope-literal-"));
  projectsHashDir = join(baseDir, "claude-projects", "fixture-project");
  stateDir = join(baseDir, "project", ".orchestrator-state", "agent-channel");
  mkdirSync(projectsHashDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  closeAgentChannelDb(stateDir);
  rmSync(baseDir, { recursive: true, force: true });
});

const file = (s: SessionEntry) => join(projectsHashDir, `${s.session_id}.jsonl`);

/** A live watcher for `receiver`, then ORCH posts `text`; returns what it emitted. */
function post(receiver: SessionEntry, text: string): ChannelNotification[] {
  for (const s of SESSIONS) writeSession(stateDir, s);
  for (const s of SESSIONS) writeFileSync(file(s), "");
  const rx: ChannelNotification[] = [];
  const chan = new AgentChannel(stateDir, projectsHashDir, receiver, (n) => rx.push(n));
  (chan as any).tick();
  (chan as any).tick();
  appendFileSync(
    file(ORCH),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n",
  );
  (chan as any).tick();
  return rx.filter((n) => n.meta.from_session === ORCH.session_id && n.meta.event_type === "assistant_text");
}

function emitLogEvents(): string[] {
  const p = join(stateDir, "emit-log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).event);
}

const SPECIMEN =
  "@@@ @PA\n**What changes:**\n- W2-B's opener `@SA-bbbbbbbb,@PA,@all` now shows `@all` to every receiver.\n@@@";

describe("an envelope body never addresses anyone", () => {
  test("SPECIMEN at PA: addressed_to is PA alone, and the header says PA", () => {
    const got = post(PA, SPECIMEN);
    expect(got).toHaveLength(1);
    expect(got[0].meta.addressed_to).toEqual([PA.session_id]);
    expect(got[0].content.startsWith("[SA-cccccccc] @PA-aaaaaaaa | ")).toBe(true);
  });

  test("SPECIMEN at the quoted SA: nothing delivered, and no false paragraph_filtered alarm", () => {
    const got = post(DESK, SPECIMEN);
    expect(got).toHaveLength(0);
    expect(emitLogEvents()).not.toContain("paragraph_filtered");
  });

  test("CONTROL: the same line OUTSIDE an envelope still addresses (comma context)", () => {
    const got = post(DESK, "- W2-B's opener `@SA-bbbbbbbb,@PA,@all` now shows it.");
    expect(got).toHaveLength(1);
  });

  test("CONTROL: an envelope that really opens to @all still reaches the SA", () => {
    const got = post(DESK, "@@@ @all\nstand down for five\n@@@");
    expect(got).toHaveLength(1);
    expect(got[0].content.startsWith("[SA-cccccccc] @all | ")).toBe(true);
  });

  test("a fenced code block is literal too: an address inside it adds no target", () => {
    const got = post(PA, "@PA see below\n\n```\n@SA-bbbbbbbb,@all\n```");
    expect(got).toHaveLength(1);
    expect(got[0].meta.addressed_to).toEqual([PA.session_id]);
  });
});
