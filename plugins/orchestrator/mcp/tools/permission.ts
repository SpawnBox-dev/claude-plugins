import { z } from "zod";
import type { PermissionVerdict } from "../engine/permission_relay";

/**
 * PA's interface for responding to a routed permission_request.
 *
 * When PA receives a `permission_request_pending` channel event in its
 * context, it evaluates the request and calls this tool with the
 * verdict + reason. The orchestrator MCP's channel router fires a
 * `permission_verdict` event back to the originating SA, whose
 * permission_relay then resolves the pending Promise and emits the
 * `notifications/claude/channel/permission` notification back to CC.
 *
 * Verdict values:
 *   - `allow`  - SA may proceed with the tool call
 *   - `deny`   - SA must NOT proceed
 *   - `defer_to_human` - PA cannot decide; falls back to terminal prompt
 *
 * `reason` is required for any non-`allow` verdict (audit + later
 * comprehension). For `allow`, reason is optional but encouraged on
 * higher-risk tools.
 */

export const RespondToPermissionInputSchema = z.object({
  request_id: z.string().describe("The request_id from the permission_request_pending channel event"),
  verdict: z
    .enum(["allow", "deny", "defer_to_human"])
    .describe("PA's verdict on the request"),
  reason: z
    .string()
    .optional()
    .describe(
      "PA's stated reasoning. Required for non-allow verdicts; encouraged on high-risk allows. Recorded in the permission_audit table.",
    ),
});

export type RespondToPermissionInput = z.infer<typeof RespondToPermissionInputSchema>;

export interface RespondToPermissionResult {
  emitted: boolean;
  message: string;
}

/**
 * Handler that emits a `permission_verdict` channel event so the
 * originating SA's permission_relay can resolve its pending Promise.
 *
 * The `emitChannelEvent` callback is injected by server.ts when it
 * registers the tool - it wires through to the actual MCP notification
 * mechanism. This separation keeps the tool handler unit-testable
 * without needing a real MCP server.
 */
export async function handleRespondToPermission(
  input: RespondToPermissionInput,
  ctx: {
    paSessionId: string;
    emitChannelEvent: (event: {
      event_type: "permission_verdict";
      request_id: string;
      verdict: PermissionVerdict;
      pa_session: string;
      pa_reason?: string;
    }) => void;
  },
): Promise<RespondToPermissionResult> {
  // Contract: non-allow verdicts MUST have a reason.
  if (input.verdict !== "allow" && (!input.reason || input.reason.trim().length === 0)) {
    return {
      emitted: false,
      message: `Refused: verdict='${input.verdict}' requires a non-empty reason (audit + later comprehension).`,
    };
  }

  ctx.emitChannelEvent({
    event_type: "permission_verdict",
    request_id: input.request_id,
    verdict: input.verdict,
    pa_session: ctx.paSessionId,
    pa_reason: input.reason,
  });

  return {
    emitted: true,
    message: `Verdict '${input.verdict}' emitted for request ${input.request_id}.`,
  };
}
