// Flap-storm fix (WI 8522c487). Tests for the three changes that end
// false session_departed/session_joined churn under load:
//   ROOT-A  positional/partial transcript read (refactor; behavior-preserving)
//   ROOT-B  new-receiver offsets init to EOF (skip pre-join history)
//   DEFENSE-C observer-side departure hysteresis + depart<->rejoin debounce
//
// Deterministic ticking via the established `(chan as any).<private>()` seam
// (same convention as agent_channel_permission.test.ts's processSystemEvents()).
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
  baseDir = mkdtempSync(join(tmpdir(), "agent-channel-flap-"));
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

function appendAssistantEvent(jsonl: string, text: string): void {
  const ev = { type: "assistant", message: { content: [{ type: "text", text }] } };
  appendFileSync(jsonl, JSON.stringify(ev) + "\n");
}

function assistantContents(received: ChannelNotification[]): string[] {
  return received
    .filter((n) => n.meta.event_type === "assistant_text")
    .map((n) => n.content);
}

describe("flap fix ROOT-B: new-receiver EOF-init skips pre-join history", () => {
  test("a new receiver does not replay pre-join transcript content, only post-join", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "abc12345", "SA-src");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    // Pre-join history: an @all message that WOULD be delivered to the observer
    // if the new receiver replayed history from offset 0.
    appendAssistantEvent(srcJsonl, "@all HISTORICAL-do-not-replay");

    const received: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));

    // First tick = first-sight of srcJsonl. EOF-init must skip the backlog.
    (paChan as any).tick();
    expect(assistantContents(received).some((c) => c.includes("HISTORICAL"))).toBe(false);

    // Content written AFTER first-sight must still be delivered.
    appendAssistantEvent(srcJsonl, "@all FRESH-deliver-me");
    (paChan as any).tick();
    expect(assistantContents(received).some((c) => c.includes("FRESH"))).toBe(true);
    // History is never delivered, even after subsequent ticks.
    expect(assistantContents(received).some((c) => c.includes("HISTORICAL"))).toBe(false);
  });
});

describe("flap fix ROOT-A: positional read (byte-offset, multibyte-safe, partial-line carry)", () => {
  test("reads the delta at a nonzero offset, preserves multibyte, and carries a partial trailing line", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "abc12345", "SA-src");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");

    const received: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));

    // First-sight EOF-init on the empty file (offset 0).
    (paChan as any).tick();

    // A first complete line advances the offset to a NONZERO byte position, so
    // the subsequent read exercises the positional read at an offset (not 0).
    appendAssistantEvent(srcJsonl, "@all FIRST-LINE plain ascii");
    (paChan as any).tick();
    expect(assistantContents(received).some((c) => c.includes("FIRST-LINE"))).toBe(true);

    // Now append a COMPLETE multibyte line (emoji + accents) followed by a
    // PARTIAL line with no trailing newline. The positional read starts at the
    // nonzero offset; the multibyte content must survive byte-based decoding,
    // and the unterminated line must NOT be delivered yet.
    const multibyte =
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "@all MULTIBYTE 🚀 éàü survives the positional read" }] },
      }) + "\n";
    const partial = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "@all PARTIAL-LINE not yet terminated" }] },
    }); // deliberately no trailing "\n"
    appendFileSync(srcJsonl, multibyte + partial);
    (paChan as any).tick();

    expect(assistantContents(received).some((c) => c.includes("🚀"))).toBe(true);
    expect(assistantContents(received).some((c) => c.includes("éàü"))).toBe(true);
    expect(assistantContents(received).some((c) => c.includes("PARTIAL-LINE"))).toBe(false);

    // Terminate the partial line; it must now be delivered exactly once, intact.
    appendFileSync(srcJsonl, "\n");
    (paChan as any).tick();
    const partialHits = assistantContents(received).filter((c) => c.includes("PARTIAL-LINE"));
    expect(partialHits.length).toBe(1);
  });
});
