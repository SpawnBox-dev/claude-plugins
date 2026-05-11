import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentChannel, type PermissionRelayLike } from "../../mcp/engine/agent_channel";
import { appendSystemEvent } from "../../mcp/engine/system_events";
import type { SessionEntry } from "../../mcp/engine/agent_channel_state";

/**
 * Integration tests for the agent_channel filewatcher's system_events
 * routing: permission_request_pending events emit channel notifications
 * to the addressed session; permission_verdict events route to the
 * injected permissionRelay.
 */

function freshTempDir(): { stateDir: string; projectsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "achan-perm-"));
  const stateDir = join(root, "state");
  const projectsDir = join(root, "projects");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  // Seed an empty sessions.json so readSessions doesn't throw
  writeFileSync(join(stateDir, "sessions.json"), JSON.stringify({ sessions: [] }));
  return {
    stateDir,
    projectsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("agent_channel permission routing via system_events bus", () => {
  let dirs: ReturnType<typeof freshTempDir>;

  beforeEach(() => {
    dirs = freshTempDir();
  });
  afterEach(() => {
    dirs.cleanup();
  });

  test("permission_request_pending addressed to self triggers emit with channel meta", () => {
    const self: SessionEntry = {
      session_id: "pa-session-uuid",
      id8: "pa-sessi",
      role: "prime",
      name: "PA",
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      current_task: null,
    };
    const emitted: any[] = [];
    const channel = new AgentChannel(
      dirs.stateDir,
      dirs.projectsDir,
      self,
      (e) => emitted.push(e),
    );

    // Write a permission_request_pending event addressed to PA
    appendSystemEvent(dirs.stateDir, {
      event_type: "permission_request_pending",
      from_session: "sa-session-uuid",
      to_session: "pa-session-uuid",
      ts: new Date().toISOString(),
      request_id: "req-1",
      tool_name: "Bash",
      description: "Run a command",
      input_preview: "ls -la",
    });

    // Manually invoke the system-events processing path (the public tick
    // also reads jsonls; we use the private method via the type-bypass to
    // test in isolation).
    (channel as any).processSystemEvents();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].meta.event_type).toBe("permission_request_pending");
    expect(emitted[0].meta.from_session).toBe("sa-session-uuid");
    expect(emitted[0].meta.pa_addressed).toBe(true);
    expect(emitted[0].content).toContain("request_id=req-1");
    expect(emitted[0].content).toContain("tool=Bash");
  });

  test("permission_request_pending NOT addressed to self is ignored", () => {
    const self: SessionEntry = {
      session_id: "other-session-uuid",
      id8: "other-se",
      role: "subordinate",
      name: "Other-SA",
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      current_task: null,
    };
    const emitted: any[] = [];
    const channel = new AgentChannel(
      dirs.stateDir,
      dirs.projectsDir,
      self,
      (e) => emitted.push(e),
    );

    // Event is addressed to PA, not to us
    appendSystemEvent(dirs.stateDir, {
      event_type: "permission_request_pending",
      from_session: "sa-session-uuid",
      to_session: "pa-session-uuid",
      ts: new Date().toISOString(),
      request_id: "req-2",
      tool_name: "Bash",
      description: "x",
      input_preview: "x",
    });

    (channel as any).processSystemEvents();
    expect(emitted).toHaveLength(0);
  });

  test("permission_verdict addressed to self routes to injected permissionRelay", () => {
    const resolved: any[] = [];
    const relay: PermissionRelayLike = {
      resolveVerdict(request_id, input) {
        resolved.push({ request_id, ...input });
      },
    };
    const self: SessionEntry = {
      session_id: "sa-session-uuid",
      id8: "sa-sessi",
      role: "subordinate",
      name: "SA",
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      current_task: null,
    };
    const emitted: any[] = [];
    const channel = new AgentChannel(
      dirs.stateDir,
      dirs.projectsDir,
      self,
      (e) => emitted.push(e),
      relay,
    );

    appendSystemEvent(dirs.stateDir, {
      event_type: "permission_verdict",
      from_session: "pa-session-uuid",
      to_session: "sa-session-uuid",
      ts: new Date().toISOString(),
      request_id: "req-3",
      verdict: "allow",
      pa_session: "pa-session-uuid",
      pa_reason: "low-risk operation",
    });

    (channel as any).processSystemEvents();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].request_id).toBe("req-3");
    expect(resolved[0].verdict).toBe("allow");
    expect(resolved[0].pa_reason).toBe("low-risk operation");
    expect(emitted).toHaveLength(0); // verdicts don't emit; they route to relay
  });

  test("permission_verdict without injected relay is silently dropped", () => {
    // PA's MCP receives a verdict that was meant for an SA. PA doesn't
    // have a relay (PA doesn't make permission_request inbound calls
    // to CC), so we just drop it. This documents the expected "no relay
    // means ignore" semantic.
    const self: SessionEntry = {
      session_id: "pa-session-uuid",
      id8: "pa-sessi",
      role: "prime",
      name: "PA",
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      current_task: null,
    };
    const emitted: any[] = [];
    const channel = new AgentChannel(
      dirs.stateDir,
      dirs.projectsDir,
      self,
      (e) => emitted.push(e),
      // no relay
    );

    appendSystemEvent(dirs.stateDir, {
      event_type: "permission_verdict",
      from_session: "sa-session-uuid",
      to_session: "pa-session-uuid",
      ts: new Date().toISOString(),
      request_id: "req-4",
      verdict: "deny",
    });

    expect(() => (channel as any).processSystemEvents()).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  test("offset tracking: events are not re-processed on subsequent ticks", () => {
    const resolved: any[] = [];
    const relay: PermissionRelayLike = {
      resolveVerdict(request_id, input) {
        resolved.push({ request_id, ...input });
      },
    };
    const self: SessionEntry = {
      session_id: "sa-session-uuid",
      id8: "sa-sessi",
      role: "subordinate",
      name: "SA",
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      current_task: null,
    };
    const channel = new AgentChannel(
      dirs.stateDir,
      dirs.projectsDir,
      self,
      () => {},
      relay,
    );

    appendSystemEvent(dirs.stateDir, {
      event_type: "permission_verdict",
      from_session: "pa-session-uuid",
      to_session: "sa-session-uuid",
      ts: new Date().toISOString(),
      request_id: "req-5",
      verdict: "deny",
      pa_reason: "x",
    });

    (channel as any).processSystemEvents();
    expect(resolved).toHaveLength(1);

    // Second tick with no new events
    (channel as any).processSystemEvents();
    expect(resolved).toHaveLength(1); // unchanged

    // Append a new event
    appendSystemEvent(dirs.stateDir, {
      event_type: "permission_verdict",
      from_session: "pa-session-uuid",
      to_session: "sa-session-uuid",
      ts: new Date().toISOString(),
      request_id: "req-6",
      verdict: "allow",
    });
    (channel as any).processSystemEvents();
    expect(resolved).toHaveLength(2);
    expect(resolved[1].request_id).toBe("req-6");
  });
});
