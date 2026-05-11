import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { PermissionRelay, type PermissionVerdict } from "../../mcp/engine/permission_relay";

describe("PermissionRelay", () => {
  let db: Database;
  let relay: PermissionRelay;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
    relay = new PermissionRelay(db, { defaultTimeoutMs: 100, selfSessionId: "self-sa" });
  });

  test("registerPending stores the request and returns a promise", async () => {
    const promise = relay.registerPending({
      request_id: "r1",
      source_session: "self-sa",
      tool_name: "Bash",
      description: "Run a command",
      input_preview: "ls -la",
    });
    expect(promise).toBeInstanceOf(Promise);

    // Verdict resolves the promise
    relay.resolveVerdict("r1", { verdict: "allow", pa_session: "pa-session", pa_reason: "low-risk" });
    const verdict = await promise;
    expect(verdict.verdict).toBe("allow");
    expect(verdict.pa_reason).toBe("low-risk");
  });

  test("registerPending writes a row to permission_audit immediately", () => {
    relay.registerPending({
      request_id: "r2",
      source_session: "self-sa",
      tool_name: "Write",
      description: "Create file",
      input_preview: "{path: '/tmp/x'}",
    });
    const row = db.query("SELECT * FROM permission_audit WHERE request_id = ?").get("r2") as any;
    expect(row).not.toBeNull();
    expect(row.source_session).toBe("self-sa");
    expect(row.tool_name).toBe("Write");
    expect(row.verdict).toBeNull();
  });

  test("resolveVerdict updates the audit row with verdict + resolution", async () => {
    const promise = relay.registerPending({
      request_id: "r3",
      source_session: "self-sa",
      tool_name: "Edit",
      description: "Modify file",
      input_preview: "{path: '/tmp/y'}",
    });
    relay.resolveVerdict("r3", { verdict: "deny", pa_session: "pa-session", pa_reason: "too risky" });
    await promise;
    const row = db.query("SELECT * FROM permission_audit WHERE request_id = ?").get("r3") as any;
    expect(row.verdict).toBe("deny");
    expect(row.pa_reason).toBe("too risky");
    expect(row.pa_session).toBe("pa-session");
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolved_by).toBe("pa");
  });

  test("verdict times out to 'defer_to_human' with resolved_by='timeout' if no PA response", async () => {
    const promise = relay.registerPending({
      request_id: "r4",
      source_session: "self-sa",
      tool_name: "Bash",
      description: "long-running",
      input_preview: "sleep 999",
    });
    const verdict = await promise;
    expect(verdict.verdict).toBe("defer_to_human");
    const row = db.query("SELECT * FROM permission_audit WHERE request_id = ?").get("r4") as any;
    expect(row.verdict).toBe("defer_to_human");
    expect(row.resolved_by).toBe("timeout");
  });

  test("resolveVerdict for unknown request_id is a no-op (no throw)", () => {
    // PA sends verdict for an already-timed-out or unknown request -
    // shouldn't crash the orchestrator MCP.
    expect(() => {
      relay.resolveVerdict("never-registered", { verdict: "allow", pa_session: "pa" });
    }).not.toThrow();
  });

  test("listSourceFor returns the originating session for a given request_id", () => {
    relay.registerPending({
      request_id: "r5",
      source_session: "sa-xyz",
      tool_name: "Bash",
      description: "x",
      input_preview: "x",
    });
    expect(relay.listSourceFor("r5")).toBe("sa-xyz");
    expect(relay.listSourceFor("never-existed")).toBeNull();
  });

  test("double-resolve only applies the first verdict", async () => {
    const promise = relay.registerPending({
      request_id: "r6",
      source_session: "self-sa",
      tool_name: "Bash",
      description: "x",
      input_preview: "x",
    });
    relay.resolveVerdict("r6", { verdict: "allow", pa_session: "pa" });
    relay.resolveVerdict("r6", { verdict: "deny", pa_session: "pa" });
    const verdict = await promise;
    expect(verdict.verdict).toBe("allow"); // first verdict wins

    const row = db.query("SELECT * FROM permission_audit WHERE request_id = ?").get("r6") as any;
    expect(row.verdict).toBe("allow"); // audit row only records the first
  });

  test("verdict types validated: only allow|deny|defer_to_human accepted", () => {
    // Spec contract: callers must pass valid verdict strings. Engine
    // doesn't try to validate beyond the type system - this test
    // documents the expected verdict surface for protocol compatibility.
    const valid: PermissionVerdict[] = ["allow", "deny", "defer_to_human"];
    for (const v of valid) {
      const id = `valid-${v}`;
      relay.registerPending({
        request_id: id,
        source_session: "self-sa",
        tool_name: "Bash",
        description: "x",
        input_preview: "x",
      });
      relay.resolveVerdict(id, { verdict: v, pa_session: "pa" });
      const row = db.query("SELECT verdict FROM permission_audit WHERE request_id = ?").get(id) as any;
      expect(row.verdict).toBe(v);
    }
  });
});
