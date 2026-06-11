// Regression repros for WI f0d66029 (2026-06-11 fleet-relaunch night):
// PA->SA deliveries observed dropped in production while single-paragraph
// directives delivered. Three suspect shapes, each reproduced here with the
// (structurally) exact payloads from the live incident.
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import {
  writeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

const PROJECT_HASH = "fixture-project";

let baseDir: string;
let projectDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "agent-channel-rg-"));
  projectDir = join(baseDir, "project");
  projectsHashDir = join(baseDir, "claude-projects", PROJECT_HASH);
  stateDir = join(projectDir, ".orchestrator-state", "agent-channel");
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
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  };
}

function assistantEventLine(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
}

function appendAssistantEvent(jsonl: string, text: string): void {
  appendFileSync(jsonl, assistantEventLine(text));
}

// The live MOOSE-742 multi-paragraph payload (structurally exact): leading
// user-facing prose paragraph ending in a colon, blank line, then the
// addressed directive paragraph containing colons + double quotes.
const MULTI_PARA_PAYLOAD = [
  "Absolutely — live round-trip demo with a fresh challenge token so it can't be a replay:",
  "",
  '@SA-abc12345 demo for Jarid, who is watching: reply on the channel with exactly this sentence: "PA\'s message arrived intact - echo token MOOSE-742 - two-way channel live." Also set your current_task to that same sentence so it shows in the registry.',
].join("\n");

// The live envelope payload (structurally exact): prose paragraphs, then an
// explicit envelope with a blank line inside the body.
const ENVELOPE_PAYLOAD = [
  "Found it — and it's my own protocol violation: the demo message was multi-paragraph with the address mid-message. Re-sending enveloped:",
  "",
  "@@@ @SA-abc12345",
  'Demo for Jarid (he is watching): reply on the channel with exactly this sentence: "PA\'s message arrived intact - echo token MOOSE-742 - two-way channel live."',
  "",
  "Also set your current_task to that same sentence so it shows in the registry.",
  "@@@",
].join("\n");

async function runWatcherOnce(
  sa: SessionEntry,
  received: ChannelNotification[],
  settleMs = 200,
): Promise<AgentChannel> {
  const chan = new AgentChannel(stateDir, projectsHashDir, sa, (n) => received.push(n));
  chan.start();
  await new Promise((r) => setTimeout(r, settleMs));
  return chan;
}

describe("WI f0d66029 regression repros", () => {
  test("multi-paragraph PA message with mid-message @SA address delivers the addressed paragraph", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const sa = makeSession("subordinate", "abc12345", "SA-A");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);

    const paJsonl = join(projectsHashDir, `${pa.session_id}.jsonl`);
    writeFileSync(paJsonl, "");
    appendAssistantEvent(paJsonl, MULTI_PARA_PAYLOAD);

    const received: ChannelNotification[] = [];
    const chan = await runWatcherOnce(sa, received);
    chan.stop();

    const contents = received
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(contents).toEqual(
      expect.arrayContaining([expect.stringContaining("MOOSE-742")]),
    );
    // Mixed-audience invariant: the user-facing prose paragraph must NOT leak.
    for (const c of contents) {
      expect(c).not.toContain("fresh challenge token");
    }
  });

  test("prose-then-envelope PA message delivers the envelope body to its target", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const sa = makeSession("subordinate", "abc12345", "SA-A");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);

    const paJsonl = join(projectsHashDir, `${pa.session_id}.jsonl`);
    writeFileSync(paJsonl, "");
    appendAssistantEvent(paJsonl, ENVELOPE_PAYLOAD);

    const received: ChannelNotification[] = [];
    const chan = await runWatcherOnce(sa, received);
    chan.stop();

    const contents = received
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(contents).toEqual(
      expect.arrayContaining([expect.stringContaining("MOOSE-742")]),
    );
    expect(contents.join("\n")).toContain("Also set your current_task");
    for (const c of contents) {
      expect(c).not.toContain("protocol violation");
    }
  });

  test("sender transcript shrink-then-regrow does not swallow newly appended directives", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const sa = makeSession("subordinate", "abc12345", "SA-A");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);

    const paJsonl = join(projectsHashDir, `${pa.session_id}.jsonl`);
    writeFileSync(paJsonl, "");

    // Phase 1: bulk content the watcher fully consumes (advances offset high).
    const bulk = assistantEventLine(
      "unaddressed filler paragraph that pads the transcript " + "x".repeat(2000),
    ).repeat(5);
    appendFileSync(paJsonl, bulk);

    const received: ChannelNotification[] = [];
    const chan = await runWatcherOnce(sa, received, 250);

    // Phase 2: CC rewrites the transcript SMALLER (observed live 2026-06-11:
    // offset 2072345 vs file size 2061306). Simulate by truncating to a
    // shorter file that still parses.
    writeFileSync(
      paJsonl,
      assistantEventLine("rewritten shorter transcript " + "y".repeat(100)),
    );
    await new Promise((r) => setTimeout(r, 1700)); // one poll cycle on the shrunk file

    // Phase 3: a NEW addressed directive appends after the shrink.
    appendAssistantEvent(paJsonl, "@SA-abc12345 post-shrink directive - reply with token OTTER-99");
    await new Promise((r) => setTimeout(r, 1700)); // one more poll cycle
    chan.stop();

    const contents = received
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(contents).toEqual(
      expect.arrayContaining([expect.stringContaining("OTTER-99")]),
    );
  });
});
