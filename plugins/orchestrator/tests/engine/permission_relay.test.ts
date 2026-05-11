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

  test("cleanup() settles in-flight Promises with shutdown verdict (no leak)", async () => {
    const p1 = relay.registerPending({
      request_id: "shut-1",
      source_session: "self-sa",
      tool_name: "Bash",
      description: "x",
      input_preview: "x",
    });
    const p2 = relay.registerPending({
      request_id: "shut-2",
      source_session: "self-sa",
      tool_name: "Edit",
      description: "y",
      input_preview: "y",
    });
    relay.cleanup();
    const v1 = await p1;
    const v2 = await p2;
    expect(v1.verdict).toBe("defer_to_human");
    expect(v1.pa_session).toBe("<shutdown>");
    expect(v2.verdict).toBe("defer_to_human");
    expect(v2.pa_session).toBe("<shutdown>");
    expect(relay.pendingCount()).toBe(0);
  });

  test("duplicate request_id registration: both callers receive the same verdict", async () => {
    const p1 = relay.registerPending({
      request_id: "dup-1",
      source_session: "self-sa",
      tool_name: "Bash",
      description: "first",
      input_preview: "first",
    });
    const p2 = relay.registerPending({
      request_id: "dup-1",
      source_session: "self-sa",
      tool_name: "Bash",
      description: "retry",
      input_preview: "retry",
    });
    relay.resolveVerdict("dup-1", {
      verdict: "allow",
      pa_session: "pa",
      pa_reason: "ok",
    });
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(v1.verdict).toBe("allow");
    expect(v2.verdict).toBe("allow");
    expect(v1.pa_reason).toBe("ok");
    // Audit row reflects only first INSERT (subsequent inserts are
    // IGNORE'd, so description='first' from the first call).
    const row = db.query("SELECT * FROM permission_audit WHERE request_id = ?").get("dup-1") as any;
    expect(row.description).toBe("first");
    expect(row.verdict).toBe("allow");
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
