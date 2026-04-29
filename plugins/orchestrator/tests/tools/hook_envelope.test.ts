// Schema-validates the JSON envelope `_hook_event` emits for every supported
// event + payload variant. Mirrors Claude Code's hook output schema:
//
//   {
//     continue?: boolean
//     suppressOutput?: boolean
//     stopReason?: string
//     decision?: "approve" | "block"
//     reason?: string
//     systemMessage?: string
//     permissionDecision?: "allow" | "deny" | "ask"
//     hookSpecificOutput?: {
//       hookEventName: "PreToolUse" | "UserPromptSubmit" | "PostToolUse" | "PostToolBatch"
//       additionalContext?: string  (REQUIRED for UserPromptSubmit)
//       permissionDecision?: "allow" | "deny" | "ask" | "defer"  (PreToolUse)
//       permissionDecisionReason?: string  (PreToolUse)
//       updatedInput?: object  (PreToolUse)
//     }
//   }
//
// This test would have caught both R7.2 (wrong server name - no, that's a
// hooks.json bug, not envelope) and R7.3 (hookSpecificOutput on non-HSO
// events). It will catch future schema drift the same way.

import { describe, expect, test } from "bun:test";
import {
  buildHookEnvelope,
  type HookEvent,
  type HookEventResponse,
  HSO_EVENTS,
} from "../../mcp/tools/hook_event";

const ALLOWED_HSO_EVENT_NAMES = new Set([
  "PreToolUse",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolBatch",
]);
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "continue",
  "suppressOutput",
  "stopReason",
  "decision",
  "reason",
  "systemMessage",
  "permissionDecision",
  "hookSpecificOutput",
]);
const ALLOWED_HSO_KEYS = new Set([
  "hookEventName",
  "additionalContext",
  "permissionDecision",
  "permissionDecisionReason",
  "updatedInput",
]);
const ALLOWED_DECISION_VALUES = new Set(["approve", "block"]);
const ALLOWED_PERMISSION_DECISION_VALUES = new Set(["allow", "deny", "ask"]);
const ALLOWED_HSO_PERMISSION_DECISION_VALUES = new Set(["allow", "deny", "ask", "defer"]);

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateEnvelope(env: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  for (const k of Object.keys(env)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(k)) errors.push(`Unknown top-level key: ${k}`);
  }

  if (env.decision !== undefined) {
    if (typeof env.decision !== "string" || !ALLOWED_DECISION_VALUES.has(env.decision)) {
      errors.push(`decision must be "approve" or "block", got: ${env.decision}`);
    }
  }
  if (env.permissionDecision !== undefined) {
    if (
      typeof env.permissionDecision !== "string" ||
      !ALLOWED_PERMISSION_DECISION_VALUES.has(env.permissionDecision)
    ) {
      errors.push(
        `top-level permissionDecision must be allow/deny/ask, got: ${env.permissionDecision}`
      );
    }
  }
  if (env.reason !== undefined && typeof env.reason !== "string") {
    errors.push(`reason must be string`);
  }
  if (env.systemMessage !== undefined && typeof env.systemMessage !== "string") {
    errors.push(`systemMessage must be string`);
  }

  if (env.hookSpecificOutput !== undefined) {
    const hso = env.hookSpecificOutput as Record<string, unknown>;
    if (!hso || typeof hso !== "object") {
      errors.push(`hookSpecificOutput must be an object`);
    } else {
      for (const k of Object.keys(hso)) {
        if (!ALLOWED_HSO_KEYS.has(k)) errors.push(`Unknown hookSpecificOutput key: ${k}`);
      }
      const eventName = hso.hookEventName as string | undefined;
      if (!eventName) {
        errors.push(`hookSpecificOutput.hookEventName is required`);
      } else if (!ALLOWED_HSO_EVENT_NAMES.has(eventName)) {
        errors.push(
          `hookSpecificOutput.hookEventName must be one of ${Array.from(ALLOWED_HSO_EVENT_NAMES).join("|")}, got: ${eventName}`
        );
      }
      if (eventName === "UserPromptSubmit" && !hso.additionalContext) {
        errors.push(`hookSpecificOutput.additionalContext is required for UserPromptSubmit`);
      }
      if (
        hso.permissionDecision !== undefined &&
        (typeof hso.permissionDecision !== "string" ||
          !ALLOWED_HSO_PERMISSION_DECISION_VALUES.has(hso.permissionDecision))
      ) {
        errors.push(
          `hookSpecificOutput.permissionDecision must be allow/deny/ask/defer, got: ${hso.permissionDecision}`
        );
      }
      if (hso.additionalContext !== undefined && typeof hso.additionalContext !== "string") {
        errors.push(`hookSpecificOutput.additionalContext must be string`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

const ALL_EVENTS: HookEvent[] = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "TaskCompleted",
];

describe("buildHookEnvelope", () => {
  describe("schema validity for every event x every plausible payload", () => {
    const payloads: Array<{ name: string; result: HookEventResponse }> = [
      { name: "empty", result: {} },
      { name: "additionalContext only", result: { additionalContext: "[orch] hi" } },
      {
        name: "permissionDecision allow",
        result: { permissionDecision: "allow", additionalContext: "ok" },
      },
      {
        name: "permissionDecision ask + reason",
        result: { permissionDecision: "ask", permissionDecisionReason: "explicit choice" },
      },
      {
        name: "decision block + reason",
        result: { decision: "block", reason: "maintenance" },
      },
      { name: "systemMessage only", result: { systemMessage: "compact imminent" } },
      {
        name: "additionalContext + decision block",
        result: { additionalContext: "extra", decision: "block", reason: "stop" },
      },
    ];

    for (const event of ALL_EVENTS) {
      for (const payload of payloads) {
        test(`${event} / ${payload.name}`, () => {
          const env = buildHookEnvelope(event, payload.result);
          const v = validateEnvelope(env);
          if (!v.valid) {
            // eslint-disable-next-line no-console
            console.error(
              `Schema violation for ${event} / ${payload.name}:\n  envelope: ${JSON.stringify(env)}\n  errors: ${v.errors.join(", ")}`
            );
          }
          expect(v.valid).toBe(true);
        });
      }
    }
  });

  describe("HSO presence rules", () => {
    test("HSO present for UserPromptSubmit / PreToolUse / PostToolUse", () => {
      for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"] as const) {
        const env = buildHookEnvelope(event, { additionalContext: "x" });
        expect(env.hookSpecificOutput).toBeDefined();
        expect((env.hookSpecificOutput as { hookEventName: string }).hookEventName).toBe(event);
      }
    });

    test("HSO absent for Stop / SubagentStop / StopFailure / PreCompact / TaskCompleted / PostToolUseFailure", () => {
      const nonHso: HookEvent[] = [
        "Stop",
        "SubagentStop",
        "StopFailure",
        "PreCompact",
        "TaskCompleted",
        "PostToolUseFailure",
      ];
      for (const event of nonHso) {
        const env = buildHookEnvelope(event, { decision: "block", reason: "maintenance" });
        expect(env.hookSpecificOutput).toBeUndefined();
      }
    });
  });

  describe("non-HSO events fold additionalContext into systemMessage", () => {
    test("Stop with additionalContext and no systemMessage -> additionalContext routed to systemMessage", () => {
      const env = buildHookEnvelope("Stop", { additionalContext: "remember to save_progress" });
      expect(env.hookSpecificOutput).toBeUndefined();
      expect(env.systemMessage).toBe("remember to save_progress");
    });

    test("PostToolUseFailure with additionalContext routes to systemMessage", () => {
      const env = buildHookEnvelope("PostToolUseFailure", {
        additionalContext: "[orch] STOP. consult-concierge.",
      });
      expect(env.systemMessage).toContain("consult-concierge");
    });

    test("TaskCompleted with additionalContext routes to systemMessage", () => {
      const env = buildHookEnvelope("TaskCompleted", {
        additionalContext: "subagent finished",
      });
      expect(env.systemMessage).toBe("subagent finished");
    });

    test("explicit systemMessage takes precedence over additionalContext folding", () => {
      const env = buildHookEnvelope("PreCompact", {
        systemMessage: "compact!",
        additionalContext: "should-not-overwrite",
      });
      expect(env.systemMessage).toBe("compact!");
    });
  });

  describe("UserPromptSubmit / HSO emission rules", () => {
    test("empty result for UserPromptSubmit produces empty envelope (HSO omitted)", () => {
      // hookSpecificOutput itself is optional in the schema. When the
      // dispatcher returns nothing for UserPromptSubmit, the envelope is
      // empty - schema-valid, just no output to the model. (In practice the
      // dispatcher always emits the rotating reminder, so this case isn't
      // reached, but the builder degrades gracefully.)
      const env = buildHookEnvelope("UserPromptSubmit", {});
      expect(env.hookSpecificOutput).toBeUndefined();
      expect(validateEnvelope(env).valid).toBe(true);
    });

    test("UserPromptSubmit with additionalContext emits HSO and is valid", () => {
      const env = buildHookEnvelope("UserPromptSubmit", { additionalContext: "[orch] hi" });
      expect(env.hookSpecificOutput).toBeDefined();
      expect(validateEnvelope(env).valid).toBe(true);
    });

    test("UserPromptSubmit ignores spurious permissionDecision (PreToolUse-only)", () => {
      // Defensive: if a dispatcher branch ever sets permissionDecision for
      // UserPromptSubmit, the builder strips it from HSO so the envelope
      // stays schema-valid.
      const env = buildHookEnvelope("UserPromptSubmit", {
        additionalContext: "x",
        permissionDecision: "ask",
      });
      const hso = env.hookSpecificOutput as Record<string, unknown>;
      expect(hso.permissionDecision).toBeUndefined();
      expect(validateEnvelope(env).valid).toBe(true);
    });
  });

  describe("regression: would-have-caught past bugs", () => {
    test("R7.3 regression: Stop with HSO must fail validation", () => {
      // Synthesize the broken envelope shape R7.3 fixed.
      const brokenEnv = {
        hookSpecificOutput: { hookEventName: "Stop" },
        decision: "block",
        reason: "...",
      };
      const v = validateEnvelope(brokenEnv);
      expect(v.valid).toBe(false);
      expect(v.errors.join(" ")).toMatch(/hookEventName must be one of/);
    });

    test("HSO_EVENTS set matches schema-allowed event names", () => {
      // Drift guard: if HSO_EVENTS gets out of sync with the schema's
      // documented HSO event names, this test fires.
      for (const e of HSO_EVENTS) {
        expect(ALLOWED_HSO_EVENT_NAMES.has(e)).toBe(true);
      }
    });
  });
});
