import { describe, expect, test } from "bun:test";
import { handleRespondToPermission } from "../../mcp/tools/permission";

describe("handleRespondToPermission", () => {
  test("allow verdict without reason: emits successfully", async () => {
    let emitted: any = null;
    const result = await handleRespondToPermission(
      { request_id: "r1", verdict: "allow" },
      {
        paSessionId: "pa-session",
        emitChannelEvent: (e) => {
          emitted = e;
        },
      },
    );
    expect(result.emitted).toBe(true);
    expect(emitted).not.toBeNull();
    expect(emitted.event_type).toBe("permission_verdict");
    expect(emitted.verdict).toBe("allow");
    expect(emitted.pa_session).toBe("pa-session");
    expect(emitted.request_id).toBe("r1");
  });

  test("deny verdict requires reason - refused without it", async () => {
    let emitted: any = null;
    const result = await handleRespondToPermission(
      { request_id: "r2", verdict: "deny" },
      {
        paSessionId: "pa-session",
        emitChannelEvent: (e) => {
          emitted = e;
        },
      },
    );
    expect(result.emitted).toBe(false);
    expect(result.message).toMatch(/requires a non-empty reason/);
    expect(emitted).toBeNull();
  });

  test("deny with reason: emits with pa_reason", async () => {
    let emitted: any = null;
    const result = await handleRespondToPermission(
      { request_id: "r3", verdict: "deny", reason: "destructive against prod" },
      {
        paSessionId: "pa-session",
        emitChannelEvent: (e) => {
          emitted = e;
        },
      },
    );
    expect(result.emitted).toBe(true);
    expect(emitted.verdict).toBe("deny");
    expect(emitted.pa_reason).toBe("destructive against prod");
  });

  test("defer_to_human requires reason", async () => {
    let emitted: any = null;
    const result = await handleRespondToPermission(
      { request_id: "r4", verdict: "defer_to_human" },
      {
        paSessionId: "pa-session",
        emitChannelEvent: (e) => {
          emitted = e;
        },
      },
    );
    expect(result.emitted).toBe(false);
    expect(emitted).toBeNull();
  });

  test("defer_to_human with reason emits", async () => {
    let emitted: any = null;
    const result = await handleRespondToPermission(
      {
        request_id: "r5",
        verdict: "defer_to_human",
        reason: "outside my policy class",
      },
      {
        paSessionId: "pa-session",
        emitChannelEvent: (e) => {
          emitted = e;
        },
      },
    );
    expect(result.emitted).toBe(true);
    expect(emitted.verdict).toBe("defer_to_human");
  });

  test("allow with whitespace-only reason still passes (allow doesn't require reason)", async () => {
    let emitted: any = null;
    const result = await handleRespondToPermission(
      { request_id: "r6", verdict: "allow", reason: "   " },
      {
        paSessionId: "pa-session",
        emitChannelEvent: (e) => {
          emitted = e;
        },
      },
    );
    expect(result.emitted).toBe(true);
    expect(emitted.pa_reason).toBe("   ");
  });

  test("deny with whitespace-only reason is refused (treated as empty)", async () => {
    let emitted: any = null;
    const result = await handleRespondToPermission(
      { request_id: "r7", verdict: "deny", reason: "   " },
      {
        paSessionId: "pa-session",
        emitChannelEvent: (e) => {
          emitted = e;
        },
      },
    );
    expect(result.emitted).toBe(false);
    expect(emitted).toBeNull();
  });
});
